import { chmod, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const binDir = path.join(root, "node_modules", "youtube-dl-exec", "bin");
const target = path.join(binDir, "yt-dlp");

const STANDALONE = {
  darwin: {
    asset: "yt-dlp_macos",
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
  },
  linux: {
    asset: "yt-dlp_linux",
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
  },
};

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`yt-dlp indirilemedi (${response.status}): ${url}`);
  }
  if (!response.body) throw new Error(`yt-dlp indirilemedi: boş yanıt`);
  await mkdir(binDir, { recursive: true });
  await pipeline(response.body, createWriteStream(dest));
  await chmod(dest, 0o755);
}

const spec = STANDALONE[process.platform];
if (!spec) {
  console.log(
    `[ensure-yt-dlp] ${process.platform}: Python 3.10+ gerekir (sistem yt-dlp script kullanılıyor).`,
  );
  process.exit(0);
}

try {
  await download(spec.url, target);
  console.log(`[ensure-yt-dlp] ${spec.asset} → ${target}`);
} catch (error) {
  console.error("[ensure-yt-dlp]", error instanceof Error ? error.message : error);
  process.exit(1);
}
