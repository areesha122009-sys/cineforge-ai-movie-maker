import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output');
const UPLOADS = path.join(ROOT, 'uploads');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, UPLOADS);
  },
  filename: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    callback(null, `${randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    files: 20,
    fileSize: 100 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    const allowed = [
      '.mp4', '.mov', '.webm', '.m4v', '.avi'
    ];

    const ext = path.extname(file.originalname).toLowerCase();

    if (allowed.includes(ext) && file.mimetype.startsWith('video/')) {
      return callback(null, true);
    }

    callback(new Error('Upload video files only: MP4, MOV, WEBM, M4V or AVI.'));
  }
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let errors = '';

    child.stderr.on('data', data => {
      errors = (errors + data.toString()).slice(-4000);
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(errors || 'FFmpeg could not assemble the movie.'));
      }
    });
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'video-assembly',
    message: 'Upload your video clips to assemble a movie.'
  });
});

app.post('/api/merge', upload.array('videos', 20), async (req, res) => {
  const files = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({
      error: 'Please upload at least one video clip.'
    });
  }

  const jobId = randomUUID();
  const jobDir = path.join(OUTPUT, jobId);

  try {
    await fs.mkdir(jobDir, { recursive: true });

    const normalized = [];

    for (let i = 0; i < files.length; i++) {
      const outputFile = path.join(
        jobDir,
        `scene-${String(i + 1).padStart(2, '0')}.mp4`
      );

      // Convert clips to a common format for reliable joining.
      await runFFmpeg([
        '-y',
        '-i', files[i].path,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=24',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        outputFile
      ]);

      normalized.push(outputFile);
    }

    const listFile = path.join(jobDir, 'concat.txt');

    const listContents = normalized
      .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
      .join('\n');

    await fs.writeFile(listFile, listContents);

    const moviePath = path.join(jobDir, 'movie.mp4');

    await runFFmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      moviePath
    ]);

    res.json({
      ok: true,
      message: 'Your movie is ready!',
      movieUrl: `/output/${jobId}/movie.mp4`,
      downloadUrl: `/output/${jobId}/movie.mp4`,
      clipsCombined: files.length
    });
  } catch (error) {
    console.error('Movie assembly error:', error);

    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});

    res.status(500).json({
      error: 'Movie assembly failed. Try smaller MP4 clips.',
      details: error.message
    });
  } finally {
    await Promise.all(
      files.map(file =>
        fs.rm(file.path, { force: true }).catch(() => {})
      )
    );
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: error.code === 'LIMIT_FILE_SIZE'
        ? 'Each clip must be smaller than 100 MB.'
        : 'Too many files or an upload limit was exceeded.'
    });
  }

  res.status(400).json({
    error: error.message || 'The request failed.'
  });
});

await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(UPLOADS, { recursive: true });

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CineForge is running on port ${PORT}`);
});
