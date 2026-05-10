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

async function extractImageUrlFromZip(buffer, req) {
  const directory = await unzipper.Open.buffer(buffer);

  const imageFile = directory.files.find(file =>
    /\.(png|jpg|jpeg|webp)$/i.test(file.path)
  );

  if (!imageFile) {
    throw new Error('NovelAI 返回了 zip，但里面没有找到图片文件');
  }

  const imageBuffer = await imageFile.buffer();

  const ext = imageFile.path.toLowerCase().endsWith('.webp')
    ? 'webp'
    : imageFile.path.toLowerCase().endsWith('.jpg') || imageFile.path.toLowerCase().endsWith('.jpeg')
      ? 'jpg'
      : 'png';

  const filename = `df_${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
  const filepath = path.join(OUTPUT_DIR, filename);

  fs.writeFileSync(filepath, imageBuffer);

  const origin = `${req.protocol}://${req.get('host')}`;
  return `${origin}/generated/${filename}`;
}

function isV4Model(model) {
  const m = String(model || '').toLowerCase();
  return (
    m.includes('nai-diffusion-4') ||
    m.includes('nai-diffusion-4-5')
  );
}

function buildFinalPrompt({
  prompt = '',
  imageDescription = '',
  style = '',
  extraPrompt = '',
}) {
  return [
    prompt,
    imageDescription,
    extraPrompt,
    style ? `${style} style` : '',
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

app.post('/api/novelai-generate', async (req, res) => {
  try {
    const {
      prompt = '',
      imageDescription = '',
      tweet = '',
      style = 'anime',
      model = 'nai-diffusion-3',
      token = '',
      extraPrompt = '',
      negativePrompt = '',
      character = '',
      handle = '',
    } = req.body || {};

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

    console.log('收到生图请求：');
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

