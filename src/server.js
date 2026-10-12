import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { fal } from '@fal-ai/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT));

if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
}

const jobs = new Map();
const MAX_SCENES = Math.min(
  8,
  Math.max(1, Number(process.env.MAX_SCENES || 8))
);

function updateJob(id, values) {
  jobs.set(id, {
    ...jobs.get(id),
    ...values,
    updatedAt: new Date().toISOString()
  });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let errors = '';

    child.stderr.on('data', data => {
      errors += data.toString();
      errors = errors.slice(-5000);
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('FFmpeg failed: ' + errors));
    });
  });
}

async function download(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  await fs.writeFile(
    destination,
    Buffer.from(await response.arrayBuffer())
  );
}

function findURL(data, candidates) {
  for (const candidate of candidates) {
    let value = data;

    for (const key of candidate) {
      value = value?.[key];
    }

    if (
      typeof value === 'string' &&
      value.startsWith('http')
    ) {
      return value;
    }
  }

  throw new Error(
    'No media URL returned by the AI provider.'
  );
}

async function generateImage(prompt) {
  const result = await fal.subscribe(
    process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell',
    {
      input: {
        prompt,
        image_size: 'landscape_16_9',
        num_images: 1
      }
    }
  );

  return findURL(result.data, [
    ['images', 0, 'url']
  ]);
}

async function generateVideo(imageURL, prompt) {
  const result = await fal.subscribe(
    process.env.FAL_VIDEO_MODEL ||
      'fal-ai/minimax-video/image-to-video',
    {
      input: {
        prompt,
        image_url: imageURL
      },
      logs: true
    }
  );

  return findURL(result.data, [
    ['video', 'url'],
    ['video_url']
  ]);
}

async function generateSound(prompt, destination) {
  const key = process.env.ELEVENLABS_API_KEY;

  if (!key) {
    throw new Error('ElevenLabs API key is missing.');
  }

  const response = await fetch(
    'https://api.elevenlabs.io/v1/sound-generation',
    {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text: prompt.slice(0, 450),
        duration_seconds: 8,
        prompt_influence: 0.55
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      'Sound generation failed: ' +
      response.status + ' ' +
      (await response.text()).slice(0, 400)
    );
  }

  await fs.writeFile(
    destination,
    Buffer.from(await response.arrayBuffer())
  );
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    videoProviderConfigured: Boolean(process.env.FAL_KEY),
    soundProviderConfigured: Boolean(
      process.env.ELEVENLABS_API_KEY
    ),
    maxScenes: MAX_SCENES
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: 'Movie job not found.'
    });
  }

  res.json(job);
});

app.post('/api/generate', async (req, res) => {
  const {
    title = 'My AI Movie',
    story,
    style = 'cinematic fantasy',
    scenes
  } = req.body || {};

  if (!process.env.FAL_KEY) {
    return res.status(400).json({
      error: 'Configure FAL_KEY on your server.'
    });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(400).json({
      error: 'Configure ELEVENLABS_API_KEY on your server.'
    });
  }

  if (
    typeof story !== 'string' ||
    story.trim().length < 20
  ) {
    return res.status(400).json({
      error: 'Enter a story of at least 20 characters.'
    });
  }

  const list = Array.isArray(scenes)
    ? scenes
    : story
        .split(/\n\s*\n/)
        .filter(part => part.trim());

  const cleanScenes = list
    .map(item => {
      if (typeof item === 'string') {
        return {
          description: item.trim(),
          sound: `Cinematic sound effects for ${item.trim()}`
        };
      }

      return {
        description: String(item.description || '').trim(),
        sound: String(item.sound || 'Cinematic ambience')
      };
    })
    .filter(item => item.description);

  if (
    cleanScenes.length === 0 ||
    cleanScenes.length > MAX_SCENES
  ) {
    return res.status(400).json({
      error: `Enter between 1 and ${MAX_SCENES} scenes.`
    });
  }

  const id = nanoid(10);
  const directory = path.join(OUTPUT, id);

  await fs.mkdir(directory, { recursive: true });

  updateJob(id, {
    id,
    title,
    status: 'queued',
    progress: 0,
    scenes: [],
    message: 'Movie queued'
  });

  res.status(202).json({ jobId: id });

  (async () => {
    const clips = [];
    const completed = [];

    try {
      updateJob(id, {
        status: 'running',
        message: 'Starting generation'
      });

      for (let i = 0; i < cleanScenes.length; i++) {
        const scene = cleanScenes[i];
        const name = `scene-${String(i + 1).padStart(2, '0')}`;

        updateJob(id, {
          message: `Generating image for scene ${i + 1}`
        });

        const imagePrompt = `
${style}, cinematic widescreen movie still.

Story:
${story.slice(0, 800)}

Current scene:
${scene.description}

Keep the characters' faces, hairstyles,
clothing, and colors consistent.

Detailed environment, cinematic lighting,
no text, no subtitles, no logos.
        `.trim();

        const imageURL = await generateImage(imagePrompt);
        const imagePath = path.join(directory, `${name}.jpg`);

        await download(imageURL, imagePath);

        updateJob(id, {
          message: `Generating video for scene ${i + 1}`
        });

        const videoURL = await generateVideo(
          imageURL,
          `${style}. Animate this scene naturally: ` +
          scene.description +
          '. Preserve the same characters and clothing. ' +
          'Smooth cinematic camera movement.'
        );

        const rawPath = path.join(directory, `${name}-raw.mp4`);

        await download(videoURL, rawPath);

        updateJob(id, {
          message: `Generating sound for scene ${i + 1}`
        });

        const soundPath = path.join(directory, `${name}.mp3`);

        await generateSound(scene.sound, soundPath);

        const clipPath = path.join(directory, `${name}.mp4`);

        // Add generated sound to the generated video.
        await runFFmpeg([
          '-y',
          '-i', rawPath,
          '-stream_loop', '-1',
          '-i', soundPath,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-shortest',
          '-movflags', '+faststart',
          clipPath
        ]);

        clips.push(clipPath);

        completed.push({
          number: i + 1,
          description: scene.description,
          video: `/output/${id}/${name}.mp4`,
          image: `/output/${id}/${name}.jpg`,
          sound: `/output/${id}/${name}.mp3`
        });

        updateJob(id, {
          progress: Math.round(
            ((i + 1) / cleanScenes.length) * 90
          ),
          scenes: completed,
          message: `Completed scene ${i + 1}`
        });
      }

      updateJob(id, {
        message: 'Assembling the final movie'
      });

      const concatPath = path.join(directory, 'concat.txt');

      const concatText = clips
        .map(file => {
          return `file '${file.replace(/'/g, "'\\''")}'`;
        })
        .join('\n');

      await fs.writeFile(concatPath, concatText);

      const finalPath = path.join(directory, 'movie.mp4');

      await runFFmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        finalPath
      ]);

      updateJob(id, {
        status: 'completed',
        progress: 100,
        message: 'Your movie is ready!',
        movieUrl: `/output/${id}/movie.mp4`,
        scenes: completed
      });
    } catch (error) {
      console.error(error);

      updateJob(id, {
        status: 'failed',
        message: error.message || 'Generation failed',
        scenes: completed
      });
    }
  })();
});

await fs.mkdir(OUTPUT, { recursive: true });

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`CineForge AI running on port ${PORT}`);
});
