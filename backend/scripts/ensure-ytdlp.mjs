// Ensures the yt-dlp binary that `youtube-dl-exec` shells out to actually exists.
//
// youtube-dl-exec ships its own postinstall, but it resolves the latest release
// through api.github.com — which is rate-limited per IP. On a shared or VPN IP
// that call returns HTTP 403 and the package silently installs with NO binary,
// so every yt-dlp call fails at spawn time with a message-less ENOENT.
//
// The release CDN below redirects to the asset directly and is not rate-limited
// by the API quota, so it keeps working when the API does not.
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

if (process.env.YOUTUBE_DL_SKIP_DOWNLOAD) {
    console.log('[yt-dlp] YOUTUBE_DL_SKIP_DOWNLOAD set, skipping.');
    process.exit(0);
}

const isWindows = process.platform === 'win32';
const filename = process.env.YOUTUBE_DL_FILENAME || (isWindows ? 'yt-dlp.exe' : 'yt-dlp');

let binDir;
try {
    const constants = require('youtube-dl-exec/src/constants');
    binDir = constants.YOUTUBE_DL_DIR;
} catch {
    binDir = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin');
}

const target = path.join(binDir, filename);
const url = process.env.YOUTUBE_DL_HOST
    || `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;

const exists = await stat(target).then(s => s.size > 0).catch(() => false);
if (exists) {
    console.log(`[yt-dlp] binary already present at ${target}`);
    process.exit(0);
}

console.log(`[yt-dlp] downloading ${url}`);
try {
    await mkdir(binDir, { recursive: true });

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    // Stream to a temp file first so an interrupted download can never leave a
    // truncated binary in place that would look "installed" on the next run.
    const temp = `${target}.download`;
    await pipeline(response.body, createWriteStream(temp));
    await rename(temp, target);
    await chmod(target, 0o755).catch(() => { });

    const { size } = await stat(target);
    console.log(`[yt-dlp] installed ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)`);
} catch (err) {
    await rm(`${target}.download`, { force: true }).catch(() => { });
    // Warn rather than exit non-zero: a transient network failure during install
    // should not fail the whole build. server.js reports the missing binary clearly.
    console.warn(`[yt-dlp] WARNING: could not download binary: ${err.message}`);
    console.warn(`[yt-dlp] YouTube downloads will fail until you run: node scripts/ensure-ytdlp.mjs`);
}
