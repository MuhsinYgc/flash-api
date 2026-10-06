import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import youtubeDl from "youtube-dl-exec";

const CACHE_MS = 30 * 60 * 1000;
const MAX_BYTES = 40 * 1024 * 1024;
const cacheDir = path.join(tmpdir(), "flash-youtube-audio");

/** @type {Map<string, Promise<{ filePath: string, contentType: string, size: number }>>} */
const pending = new Map();

const MIME = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  webm: "audio/webm",
  opus: "audio/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
  aac: "audio/aac",
};

export function isVideoId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value);
}

function failureMessage(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const message = stderr || (error instanceof Error ? error.message : "");
  const combined = `${message}\n${stderr}`;
  if (/ENOENT/i.test(combined) || /spawn.*yt-dlp/i.test(combined)) {
    return "yt-dlp bulunamadı. node_modules/youtube-dl-exec/bin içine kur.";
  }
  const line = message
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .pop();
  return (line || "Ses indirilemedi.").slice(0, 240);
}

async function listFiles(videoId) {
  const names = await readdir(cacheDir).catch(() => []);
  /** @type {{ filePath: string, size: number, mtimeMs: number, ext: string }[]} */
  const matches = [];
  for (const name of names) {
    if (!name.startsWith(`${videoId}.`)) continue;
    if (name.endsWith(".part") || name.endsWith(".ytdl")) continue;
    const filePath = path.join(cacheDir, name);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || info.size <= 0) continue;
    matches.push({
      filePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ext: path.extname(name).slice(1).toLowerCase(),
    });
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches;
}

async function clearFiles(videoId) {
  const names = await readdir(cacheDir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name.startsWith(`${videoId}.`))
      .map((name) => rm(path.join(cacheDir, name), { force: true })),
  );
}

function asAudio(file) {
  if (file.size > MAX_BYTES) {
    throw new Error("Ses 40 MB’dan büyük.");
  }
  return {
    filePath: file.filePath,
    contentType: MIME[file.ext] ?? "application/octet-stream",
    size: file.size,
  };
}

async function pruneAudioCache() {
  const names = await readdir(cacheDir).catch(() => []);
  const now = Date.now();
  await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(cacheDir, name);
      const info = await stat(filePath).catch(() => null);
      if (info && now - info.mtimeMs > CACHE_MS) {
        await rm(filePath, { force: true });
      }
    }),
  );
}

async function freshAudio(videoId) {
  await pruneAudioCache();
  const cached = (await listFiles(videoId))[0];
  if (cached && Date.now() - cached.mtimeMs < CACHE_MS && cached.size <= MAX_BYTES) {
    return asAudio(cached);
  }
  await mkdir(cacheDir, { recursive: true });
  await clearFiles(videoId);
  try {
    await youtubeDl.exec(`https://www.youtube.com/watch?v=${videoId}`, {
      output: path.join(cacheDir, `${videoId}.%(ext)s`),
      format: "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      quiet: true,
      forceOverwrites: true,
      maxFilesize: "40M",
      jsRuntimes: "node",
    });
  } catch (error) {
    await clearFiles(videoId);
    throw new Error(failureMessage(error));
  }
  const file = (await listFiles(videoId))[0];
  if (!file) throw new Error("Ses indirilemedi.");
  if (file.size > MAX_BYTES) {
    await clearFiles(videoId);
    throw new Error("Ses 40 MB’dan büyük.");
  }
  return asAudio(file);
}

export function loadYouTubeAudio(videoId) {
  const existing = pending.get(videoId);
  if (existing) return existing;
  const job = freshAudio(videoId).finally(() => {
    pending.delete(videoId);
  });
  pending.set(videoId, job);
  return job;
}

export async function fetchYouTubeTitle(videoId) {
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Video bulunamadı.");
  const data = await response.json();
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  if (!title) throw new Error("Video bulunamadı.");
  return title.slice(0, 140);
}
