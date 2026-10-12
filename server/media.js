import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, paths } from './config.js';
import { library, newId } from './library.js';
import { parseFrames } from './mp3.js';

function run(cmd, args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    // No shell: arguments are passed straight to the binary, so file names
    // can never be interpreted as commands.
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${cmd} not found. Install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH.`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${stderr.trim().split('\n').pop()}`));
    });
  });
}

export async function probe(file) {
  const out = await run(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    timeoutMs: 60_000,
  });
  const info = JSON.parse(out);
  const tags = {};
  for (const src of [info.format?.tags, ...(info.streams || []).map((s) => s.tags)]) {
    for (const [k, v] of Object.entries(src || {})) {
      const key = k.toLowerCase();
      if (!(key in tags)) tags[key] = v;
    }
  }
  return {
    tags,
    duration: Number(info.format?.duration) || 0,
    hasAudio: (info.streams || []).some((s) => s.codec_type === 'audio'),
    hasCover: (info.streams || []).some((s) => s.codec_type === 'video' && s.disposition?.attached_pic),
    hasVideo: (info.streams || []).some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic),
    width: (info.streams || []).find((s) => s.codec_type === 'video')?.width || 0,
  };
}

/** Normalize any audio file into the stream's exact format: CBR MP3, 44.1kHz stereo, no tags. */
async function transcodeAudio(input, output) {
  const filters = config.loudnorm ? ['-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100'] : [];
  await run(config.ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-i', input,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
    ...filters,
    '-ac', '2', '-ar', '44100',
    '-c:a', 'libmp3lame', '-b:a', `${config.bitrate}k`,
    '-write_xing', '0', '-id3v2_version', '0', '-write_id3v1', '0',
    '-f', 'mp3', output,
  ]);
}

/** Re-encode any image (or a file's embedded art) to a clean square-ish JPEG. Also strips EXIF. */
export async function makeJpeg(input, output, maxSize = 800) {
  await run(config.ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-i', input,
    '-map', '0:v:0', '-frames:v', '1', '-map_metadata', '-1',
    '-vf', `scale='min(${maxSize},iw)':-1`, '-q:v', '3',
    '-f', 'image2', '-c:v', 'mjpeg', output,
  ], { timeoutMs: 60_000 });
}

export async function makeBackgroundVideo(input, output) {
  // Muted, web-friendly H.264, capped at 1080p. Audio is dropped on purpose.
  await run(config.ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-i', input,
    '-map', '0:v:0', '-an', '-map_metadata', '-1',
    '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', output,
  ]);
}

// --- Upload processing queue (one at a time so the server stays responsive) ---

const queue = [];
let busy = false;

function titleFromFilename(name) {
  return path.basename(name, path.extname(name)).replace(/[_]+/g, ' ').trim() || 'Untitled';
}

export function enqueueUpload({ tmpPath, originalName, coverTmpPath = null, meta = {} }) {
  const id = newId();
  const track = library.add({
    id,
    title: meta.title || titleFromFilename(originalName),
    artist: meta.artist || '',
    album: meta.album || '',
    links: {},
    enabled: true,
    status: 'processing',
    error: null,
    duration: 0,
    audioFile: null,
    coverFile: null,
    coverRev: 0,
    plays: 0,
    addedAt: Date.now(),
    originalName: String(originalName).slice(0, 200),
  });
  if (meta.links) library.update(id, { links: meta.links });
  queue.push({ id, tmpPath, coverTmpPath, meta });
  pump();
  return track;
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    await processJob(job);
  } catch (err) {
    console.error(`[media] ${job.id}:`, err.message);
    library.update(job.id, { status: 'error', error: err.message.slice(0, 300) });
  } finally {
    for (const f of [job.tmpPath, job.coverTmpPath]) if (f) fs.rm(f, { force: true }, () => {});
    busy = false;
    pump();
  }
}

async function processJob({ id, tmpPath, coverTmpPath, meta }) {
  const info = await probe(tmpPath);
  if (!info.hasAudio) throw new Error('File has no audio stream.');

  const audioFile = `${id}.mp3`;
  const audioPath = path.join(paths.audio, audioFile);
  await transcodeAudio(tmpPath, audioPath);

  // Exact duration from the frames we will actually broadcast.
  const frames = parseFrames(fs.readFileSync(audioPath));
  if (!frames.length) throw new Error('Transcode produced no audio frames.');
  const duration = frames.reduce((sum, f) => sum + f.duration, 0);

  let coverFile = null;
  const coverOut = path.join(paths.covers, `${id}.jpg`);
  try {
    if (coverTmpPath) await makeJpeg(coverTmpPath, coverOut);
    else if (info.hasCover) await makeJpeg(tmpPath, coverOut);
    if (fs.existsSync(coverOut)) coverFile = `${id}.jpg`;
  } catch (err) {
    console.warn(`[media] cover for ${id} skipped:`, err.message);
  }

  const track = library.get(id);
  if (!track) {
    // Deleted while processing.
    fs.rm(audioPath, { force: true }, () => {});
    fs.rm(coverOut, { force: true }, () => {});
    return;
  }
  const t = info.tags;
  library.update(id, {
    // Fields the admin typed win over embedded tags.
    title: meta.title || t.title || track.title,
    artist: meta.artist || t.artist || t.album_artist || '',
    album: meta.album || t.album || '',
    audioFile,
    coverFile,
    coverRev: Date.now(),
    duration,
    status: 'ready',
    error: null,
  });

  // Group into an album: the one picked at upload, else the one named in the tags.
  const updated = library.get(id);
  let albumId = library.getAlbum(meta.albumId)?.id || null;
  if (!albumId && updated.album) {
    albumId = library.findOrCreateAlbum(updated.album, t.album_artist || updated.artist).id;
  }
  if (albumId) {
    library.update(id, { albumId });
    library.adoptCover(albumId, library.get(id));
  }
  console.log(`[media] ready: ${library.get(id).artist} - ${library.get(id).title} (${duration.toFixed(1)}s)`);
}

export async function checkFfmpeg() {
  try {
    await run(config.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
    await run(config.ffprobe, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
    return true;
  } catch (err) {
    console.error(`[media] ${err.message}`);
    return false;
  }
}
