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

async function generateWithNiniJoker(req, res, opts) {
  const {
    prompt,
    imageDescription,
    style,
    customStyle,
    model,
    upstreamEndpoint,
    upstreamKey,
    extraPrompt,
    negativePrompt,
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
  url.searchParams.set('size', '832x1216');
  url.searchParams.set('steps', '28');
  url.searchParams.set('scale', '5.0');
  url.searchParams.set('cfg', '0');
  url.searchParams.set('sampler', 'k_euler_ancestral');
  url.searchParams.set('negative', finalNegativePrompt);
  url.searchParams.set('tag', finalPrompt);

  console.log('收到 NiniJoker 生图请求：');
  console.log({
    endpoint,
    model: model || 'nai-diffusion-4-5-full',
    prompt: finalPrompt,
    negativePrompt: finalNegativePrompt,
  });

  const imageResponse = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'image/png,image/jpeg,image/webp,*/*',
    },
  });

  if (!imageResponse.ok) {
    const text = await imageResponse.text().catch(() => '');

    console.error('NiniJoker 返回错误：', imageResponse.status, text);

    return res.status(imageResponse.status).json({
      error:
        imageResponse.status === 401 || imageResponse.status === 403
          ? '401/403：Key 无效或权限不足。检查 upstreamKey。'
          : `NiniJoker 生成失败：${imageResponse.status}`,
      detail: text.slice(0, 500),
    });
  }

  const contentType = imageResponse.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await imageResponse.json();

    const imageUrl =
      data.imageUrl ||
      data.image_url ||
      data.url ||
      data.data?.[0]?.url ||
      '';

    const base64 =
      data.base64 ||
      data.image ||
      data.data?.[0]?.b64_json ||
      '';

    if (!imageUrl && !base64) {
      return res.status(500).json({
        error: 'NiniJoker 返回了 JSON，但没有 imageUrl / base64 / url。',
        detail: JSON.stringify(data).slice(0, 500),
      });
    }

    return res.json({
      imageUrl,
      base64,
      model,
      provider: 'custom',
    });
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  let ext = 'png';

  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    ext = 'jpg';
  }

  if (contentType.includes('webp')) {
    ext = 'webp';
  }

  const imageUrl = await saveImageBuffer(buffer, ext, req);

  return res.json({
    imageUrl,
    model,
    provider: 'custom',
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
    } = req.body || {};

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
