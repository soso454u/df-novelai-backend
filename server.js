import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const OUTPUT_DIR = path.resolve('./generated');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

app.use('/generated', express.static(OUTPUT_DIR));

/**
 * NiniJoker 浏览器跳转缓存
 * 作用：
 * 后端不直接 fetch 第三方图片，避免 Railway 服务器请求被拦。
 * 前端拿到 /api/ninijoker-image/:id 后，由浏览器自己加载图片。
 */
const NINI_REDIRECT_CACHE = new Map();

function createNiniRedirectUrl(realUrl, req) {
  const id = `nini_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  NINI_REDIRECT_CACHE.set(id, {
    url: realUrl,
    createdAt: Date.now(),
  });

  setTimeout(() => {
    NINI_REDIRECT_CACHE.delete(id);
  }, 10 * 60 * 1000);

  const origin = `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/ninijoker-image/${id}`;
}

app.get('/api/ninijoker-image/:id', (req, res) => {
  const item = NINI_REDIRECT_CACHE.get(req.params.id);

  if (!item) {
    return res.status(404).send('图片链接已过期，请重新生成');
  }

  return res.redirect(302, item.url);
});

app.get('/', (req, res) => {
  res.send('DF NovelAI 后端运行中');
});

async function saveImageBuffer(buffer, ext, req) {
  const filename = `df_${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
  const filepath = path.join(OUTPUT_DIR, filename);

  fs.writeFileSync(filepath, buffer);

  const origin = `${req.protocol}://${req.get('host')}`;
  return `${origin}/generated/${filename}`;
}

async function extractImageUrlFromZip(buffer, req) {
  const directory = await unzipper.Open.buffer(buffer);

  const imageFile = directory.files.find(file =>
    /\.(png|jpg|jpeg|webp)$/i.test(file.path)
  );

  if (!imageFile) {
    throw new Error('NovelAI 返回了 zip，但里面没有找到图片文件');
  }

  const imageBuffer = await imageFile.buffer();
  const lowerPath = imageFile.path.toLowerCase();

  const ext = lowerPath.endsWith('.webp')
    ? 'webp'
    : lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')
      ? 'jpg'
      : 'png';

  return saveImageBuffer(imageBuffer, ext, req);
}

function isV4Model(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('nai-diffusion-4') || m.includes('nai-diffusion-4-5');
}

function buildFinalPrompt({
  prompt = '',
  imageDescription = '',
  style = '',
  customStyle = '',
  extraPrompt = '',
}) {
  const styleText = customStyle || style;

  return [
    extraPrompt,
    prompt,
    imageDescription,
    styleText ? `${styleText} style` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function buildNegativePrompt(negativePrompt = '') {
  const baseNegative =
    negativePrompt ||
    'low quality, blurry, deformed, extra limbs, bad anatomy, ugly';

  return [
    baseNegative,
    'text, watermark, logo, signature, username, caption, ui, interface, letters, words',
  ].join(', ');
}

function normalizeNiniEndpoint(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');

  if (!clean) {
    throw new Error('缺少 upstreamEndpoint。请填写第三方接口地址。');
  }

  if (clean.endsWith('/generate')) {
    return clean;
  }

  return `${clean}/generate`;
}

function normalizeOpenAIEndpoint(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');

  if (!clean) {
    throw new Error('缺少 upstreamEndpoint。请填写 OpenAI 格式接口地址。');
  }

  if (clean.endsWith('/images/generations')) {
    return clean;
  }

  if (clean.endsWith('/v1')) {
    return `${clean}/images/generations`;
  }

  return `${clean}/v1/images/generations`;
}

function normalizeOpenAIModelsEndpoint(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');

  if (!clean) {
    throw new Error('缺少 upstreamEndpoint。请填写 OpenAI 格式接口地址。');
  }

  if (clean.endsWith('/images/generations')) {
    return clean.replace('/images/generations', '/models');
  }

  if (clean.endsWith('/v1')) {
    return `${clean}/models`;
  }

  return `${clean}/v1/models`;
}

/**
 * custom = NiniJoker / generate 链接式接口
 * 这里不 fetch 图片，只返回 redirect URL。
 */
async function generateWithNiniJoker(req, res, opts) {
  const {
    prompt = '',
    imageDescription = '',
    style = 'anime',
    customStyle = '',
    model = 'nai-diffusion-4-5-full',
    upstreamEndpoint = '',
    upstreamKey = '',
    extraPrompt = '',
    negativePrompt = '',

    niniSize = '832x1216',
    niniSteps = '28',
    niniScale = '5.0',
    niniCfg = '0',
    niniSampler = 'k_euler_ancestral',
  } = opts;

  if (!upstreamKey) {
    return res.status(400).json({
      error: '缺少 upstreamKey。请在 DF设置 里填写第三方 API Key。',
    });
  }

  if (!prompt) {
    return res.status(400).json({
      error: '缺少 prompt。',
    });
  }

  const finalPrompt = buildFinalPrompt({
    prompt,
    imageDescription,
    style,
    customStyle,
    extraPrompt,
  });

  const finalNegativePrompt = buildNegativePrompt(negativePrompt);

  const endpoint = normalizeNiniEndpoint(upstreamEndpoint);
  const url = new URL(endpoint);

  url.searchParams.set('token', upstreamKey);
  url.searchParams.set('model', model || 'nai-diffusion-4-5-full');
  url.searchParams.set('size', niniSize || '832x1216');
  url.searchParams.set('steps', String(niniSteps || '28'));
  url.searchParams.set('scale', String(niniScale || '5.0'));
  url.searchParams.set('cfg', String(niniCfg || '0'));
  url.searchParams.set('sampler', niniSampler || 'k_euler_ancestral');
  url.searchParams.set('negative', finalNegativePrompt);
  url.searchParams.set('tag', finalPrompt);

  console.log('收到 NiniJoker 生图请求：');
  console.log({
    endpoint,
    model: model || 'nai-diffusion-4-5-full',
    size: niniSize,
    steps: niniSteps,
    scale: niniScale,
    cfg: niniCfg,
    sampler: niniSampler,
    prompt: finalPrompt,
    negativePrompt: finalNegativePrompt,
    mode: 'browser_redirect',
  });

  const imageUrl = createNiniRedirectUrl(url.toString(), req);

  return res.json({
    imageUrl,
    model: model || 'nai-diffusion-4-5-full',
    provider: 'custom',
    mode: 'browser_redirect',
  });
}

/**
 * openai = OpenAI 格式第三方接口
 * 常见请求：
 * POST /v1/images/generations
 * Authorization: Bearer xxx
 */
async function generateWithOpenAICompatible(req, res, opts) {
  const {
    prompt = '',
    imageDescription = '',
    style = 'anime',
    customStyle = '',
    model = 'gpt-image-1',
    upstreamEndpoint = '',
    upstreamKey = '',
    extraPrompt = '',
    negativePrompt = '',

    openaiSize = '1024x1536',
    openaiQuality = 'auto',
    openaiN = 1,
  } = opts;

  if (!upstreamKey) {
    return res.status(400).json({
      error: '缺少 upstreamKey。请在 DF设置 里填写 OpenAI 格式接口 Key。',
    });
  }

  if (!prompt) {
    return res.status(400).json({
      error: '缺少 prompt。',
    });
  }

  const finalPrompt = buildFinalPrompt({
    prompt,
    imageDescription,
    style,
    customStyle,
    extraPrompt,
  });

  const endpoint = normalizeOpenAIEndpoint(upstreamEndpoint);

  console.log('收到 OpenAI 格式生图请求：');
  console.log({
    endpoint,
    model,
    size: openaiSize,
    quality: openaiQuality,
    n: openaiN,
    prompt: finalPrompt,
    negativePrompt,
  });

  const body = {
    model: model || 'gpt-image-1',
    prompt: finalPrompt,
    n: Number(openaiN) || 1,
    size: openaiSize || '1024x1536',
  };

  /**
   * 不是所有第三方都支持 quality。
   * 但 gpt-image-1 / dall-e-3 常见会支持。
   */
  if (openaiQuality && openaiQuality !== 'none') {
    body.quality = openaiQuality;
  }

  /**
   * OpenAI 官方 images/generations 没有 negative_prompt 标准字段。
   * 有些第三方支持，所以这里用扩展字段传过去。
   * 不支持的接口可能会报 400，到时候把 negativePrompt 清空即可。
   */
  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }

  const apiResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${upstreamKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await apiResponse.text();

  if (!apiResponse.ok) {
    console.error('OpenAI 格式接口返回错误：', apiResponse.status, text);

    return res.status(apiResponse.status).json({
      error: `OpenAI 格式接口生成失败：${apiResponse.status}`,
      detail: text.slice(0, 800),
    });
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    return res.status(500).json({
      error: 'OpenAI 格式接口没有返回 JSON。',
      detail: text.slice(0, 800),
    });
  }

  const imageUrl =
    data.imageUrl ||
    data.image_url ||
    data.url ||
    data.data?.[0]?.url ||
    '';

  const base64 =
    data.base64 ||
    data.image ||
    data.b64_json ||
    data.data?.[0]?.b64_json ||
    '';

  if (!imageUrl && !base64) {
    return res.status(500).json({
      error: 'OpenAI 格式接口没有返回 imageUrl / base64 / data[0].url / data[0].b64_json。',
      detail: JSON.stringify(data).slice(0, 800),
    });
  }

  return res.json({
    imageUrl,
    base64,
    model,
    provider: 'openai',
  });
}

async function generateWithNovelAI(req, res, opts) {
  const {
    prompt = '',
    imageDescription = '',
    tweet = '',
    style = 'anime',
    customStyle = '',
    model = 'nai-diffusion-3',
    token = '',
    extraPrompt = '',
    negativePrompt = '',
    character = '',
    handle = '',
  } = opts;

  if (!token) {
    return res.status(400).json({
      error: '缺少 NovelAI Token。请在 DF设置 里填写 token。',
    });
  }

  if (!prompt) {
    return res.status(400).json({
      error: '缺少 prompt。',
    });
  }

  const finalPrompt = buildFinalPrompt({
    prompt,
    imageDescription,
    style,
    customStyle,
    extraPrompt,
  });

  const finalNegativePrompt = buildNegativePrompt(negativePrompt);

  const seed = Math.floor(Math.random() * 4294967295);
  const useV4 = isV4Model(model);

  const parameters = useV4
    ? {
        params_version: 3,

        width: 832,
        height: 1216,
        scale: 7,
        sampler: 'k_euler_ancestral',
        steps: 28,
        seed,
        n_samples: 1,

        ucPreset: 0,
        qualityToggle: true,
        negative_prompt: finalNegativePrompt,

        characterPrompts: [],
        v4_prompt: {
          caption: {
            base_caption: finalPrompt,
            char_captions: [],
          },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: {
            base_caption: finalNegativePrompt,
            char_captions: [],
          },
          legacy_uc: false,
        },

        use_coords: false,
        legacy: false,
        legacy_v3_extend: false,
        legacy_uc: false,

        noise_schedule: 'karras',
        dynamic_thresholding: false,
        controlnet_strength: 1,
        add_original_image: false,

        deliberate_euler_ancestral_bug: false,
        prefer_brownian: true,
      }
    : {
        width: 832,
        height: 1216,
        scale: 7,
        sampler: 'k_euler',
        steps: 28,
        seed,
        n_samples: 1,

        ucPreset: 0,
        qualityToggle: true,
        negative_prompt: finalNegativePrompt,
      };

  console.log('收到 NovelAI 生图请求：');
  console.log({
    model,
    style,
    useV4,
    prompt: finalPrompt,
    negativePrompt: finalNegativePrompt,
    seed,
    character,
    handle,
    tweet,
  });

  const naiResponse = await fetch('https://image.novelai.net/ai/generate-image', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/x-zip-compressed',
    },
    body: JSON.stringify({
      input: finalPrompt,
      model,
      action: 'generate',
      parameters,
    }),
  });

  if (!naiResponse.ok) {
    const text = await naiResponse.text().catch(() => '');

    console.error('NovelAI 返回错误：', naiResponse.status, text);

    return res.status(naiResponse.status).json({
      error: `NovelAI 生成失败：${naiResponse.status}`,
      detail: text.slice(0, 500),
    });
  }

  const arrayBuffer = await naiResponse.arrayBuffer();
  const zipBuffer = Buffer.from(arrayBuffer);

  const imageUrl = await extractImageUrlFromZip(zipBuffer, req);

  return res.json({
    imageUrl,
    seed,
    model,
    provider: 'novelai',
  });
}

/**
 * 拉取模型列表
 * provider=openai 时会请求 /v1/models
 * provider=custom / novelai 返回内置候选。
 */
app.post('/api/models', async (req, res) => {
  try {
    const {
      provider = 'custom',
      upstreamEndpoint = '',
      upstreamKey = '',
    } = req.body || {};

    if (provider === 'openai') {
      if (!upstreamKey) {
        return res.status(400).json({
          error: '缺少 upstreamKey。',
        });
      }

      const modelsEndpoint = normalizeOpenAIModelsEndpoint(upstreamEndpoint);

      const modelResponse = await fetch(modelsEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${upstreamKey}`,
          Accept: 'application/json',
        },
      });

      const text = await modelResponse.text();

      if (!modelResponse.ok) {
        return res.status(modelResponse.status).json({
          error: `拉取模型失败：${modelResponse.status}`,
          detail: text.slice(0, 800),
        });
      }

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        return res.status(500).json({
          error: '模型接口没有返回 JSON。',
          detail: text.slice(0, 800),
        });
      }

      const models = Array.isArray(data.data)
        ? data.data
            .map(item => item.id || item.name)
            .filter(Boolean)
        : [];

      return res.json({
        provider,
        models,
      });
    }

    if (provider === 'custom' || provider === 'novelai') {
      return res.json({
        provider,
        models: [
          'nai-diffusion-4-5-full',
          'nai-diffusion-4-full',
          'nai-diffusion-4-curated-preview',
          'nai-diffusion-3',
        ],
      });
    }

    return res.json({
      provider,
      models: [],
    });
  } catch (err) {
    console.error('拉取模型失败：', err);

    return res.status(500).json({
      error: err.message || '拉取模型失败',
    });
  }
});

app.post('/api/novelai-generate', async (req, res) => {
  try {
    const {
      provider = 'novelai',

      prompt = '',
      imageDescription = '',
      tweet = '',

      style = 'anime',
      customStyle = '',
      model = 'nai-diffusion-3',

      token = '',
      upstreamEndpoint = '',
      upstreamKey = '',

      extraPrompt = '',
      negativePrompt = '',

      character = '',
      handle = '',

      niniSize = '832x1216',
      niniSteps = '28',
      niniScale = '5.0',
      niniCfg = '0',
      niniSampler = 'k_euler_ancestral',

      openaiSize = '1024x1536',
      openaiQuality = 'auto',
      openaiN = 1,
    } = req.body || {};

    /**
     * custom 必须在检查 NovelAI token 前分流。
     */
    if (provider === 'custom') {
      return await generateWithNiniJoker(req, res, {
        prompt,
        imageDescription,
        tweet,
        style,
        customStyle,
        model,
        upstreamEndpoint,
        upstreamKey,
        extraPrompt,
        negativePrompt,
        character,
        handle,

        niniSize,
        niniSteps,
        niniScale,
        niniCfg,
        niniSampler,
      });
    }

    if (provider === 'openai') {
      return await generateWithOpenAICompatible(req, res, {
        prompt,
        imageDescription,
        tweet,
        style,
        customStyle,
        model,
        upstreamEndpoint,
        upstreamKey,
        extraPrompt,
        negativePrompt,
        character,
        handle,

        openaiSize,
        openaiQuality,
        openaiN,
      });
    }

    return await generateWithNovelAI(req, res, {
      prompt,
      imageDescription,
      tweet,
      style,
      customStyle,
      model,
      token,
      extraPrompt,
      negativePrompt,
      character,
      handle,
    });
  } catch (err) {
    console.error('后端错误：', err);

    return res.status(500).json({
      error: err.message || '后端未知错误',
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`DF NovelAI 后端已启动，端口：${PORT}`);
});
