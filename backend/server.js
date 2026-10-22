import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import { Markup, Telegraf } from "telegraf";
import job from './lib/cron.js';
import { create as createYoutubeDl } from 'youtube-dl-exec';
import fs from 'fs';
import os from 'os';
import path from 'path';
import FormData from 'form-data';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';

import User from './models/User.js';
import connectDB from './config/db.js';

dotenv.config();

connectDB();

const youtubeDl = createYoutubeDl('/usr/local/bin/yt-dlp');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACK = 'savedtiktoka_by_emoji_saverbot';

const app = express();
const PORT = process.env.PORT;
const frontendURL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.BACKEND_URL;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const BOT_HANDLER_TIMEOUT_MS = DOWNLOAD_TIMEOUT_MS + 30 * 1000;
const YTDLP_TIMEOUT_OPTIONS = {
    timeout: DOWNLOAD_TIMEOUT_MS,
    killSignal: 'SIGKILL'
};

// YouTube files are downloaded to the server because direct googlevideo URLs are
// bound to this machine's IP and expire, so Telegram cannot fetch them itself.
const TELEGRAM_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024; // Bot API upload limit
const YT_TEMP_PREFIX = 'yt_';
const YT_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const YT_QUALITY_STEPS = [720, 480, 360]; // tried in order until the file fits
const YT_MAX_CONCURRENT_DOWNLOADS = 2;
const YT_QUALITY_SELECTION_TTL_MS = 10 * 60 * 1000;
const YT_MAX_SELECTABLE_HEIGHT = 1080;

// Instagram/Facebook media is downloaded to the server too: Telegram's own
// fetcher is often rejected by those CDNs, and sending by URL is capped at
// 20 MB, while a direct Bot API upload allows 50 MB.
const IG_TEMP_PREFIX = 'ig_';
const MEDIA_TEMP_PREFIXES = [YT_TEMP_PREFIX, IG_TEMP_PREFIX];
const IG_COMPRESS_STEPS = [
    { crf: 28, maxHeight: 720, maxRateKbps: 2500, audioKbps: 96 },
    { crf: 30, maxHeight: 480, maxRateKbps: 1500, audioKbps: 96 },
    { crf: 32, maxHeight: 360, maxRateKbps: 900, audioKbps: 64 },
];
const TELEGRAM_CAPTION_LIMIT = 1024; // Bot API caption limit, else send fails

// A quality selection is intentionally short-lived: YouTube formats and their
// signed URLs change, and callback data must stay well below Telegram's limit.
const pendingYouTubeQualitySelections = new Map();

// CORS configuration
const allowedOrigins = [
    // frontend
    'https://social-scrapper.hantar.qzz.io',
    'https://tiktok-bot-downloader.vercel.app',
    'https://tiktok-bot-kappa.vercel.app',
    // development
    'http://localhost:5173'
];

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('Multi-Platform Downloader API is running!');
});

const E = {
    // platform logos: put the real IDs here
    instagram: '5305474827602140530',
    tiktok: '5305761237496277576',
    youtube: '5305416141169008327',
    pinterest: '5305490186405190373',
    twitter: '5305777524012262308',
    facebook: '5305421033136756692',
    vk: '5305490186405190373',
    reddit: '5305311717629142471',
    twitch: '5305294597889499194',
    vimeo: '5359708582239578213',
    ok: '5305371185746319967',
    tumblr: '5305311717629142471',
    likee: '5305290882742788410',
    soundcloud: '5305558940241665512',
    applemusic: '5305777524012262308',
    spotify: '5305551797711053969',
    threads: '5305294597889499194',

    // UI icons: candidates from your list, verify each visually
    arrow: '',                    // the green arrow before "My options"
    star: '5305348452484427680', // ⭐️ (#89)
    hide: '5305732070373367639', // ✖️ (#29)
    audio: '5305534793935527938', // 🎵 (#103) or 5289766921019892014 (#137)
    support: '',
    language: '',
    addbot: '5305761237496277576', // 💬 (#10), try others if wrong
};

// ---------- 2. HELPERS ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// custom emoji in message text (falls back to a plain emoji if no id set)
const ce = (id, fallback) => (id ? `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : fallback);

// inline button with optional custom icon
const btn = (text, data, iconId, style) => {
    const b = { text, callback_data: data };
    if (iconId) b.icon_custom_emoji_id = iconId;
    if (style) b.style = style;   // 'primary' | 'success' | 'danger'
    return b;
};


// ---------- 3. TEXT ----------
const optionsText = (subscriptionActive = false) =>
    `${ce(E.arrow, '⬇️')} <b>My options:</b>\n\n` +
    `${ce(E.instagram, '📸')} <b>Instagram:</b> reels, posts &amp; stories\n` +
    `${ce(E.tiktok, '🎵')} <b>Tiktok:</b> videos, photos &amp; audio\n` +
    `${ce(E.youtube, '▶️')} <b>YouTube:</b> videos &amp; music\n` +
    `${ce(E.pinterest, '📌')} <b>Pinterest:</b> videos &amp; stories\n` +
    `${ce(E.twitter, '🐦')} <b>Twitter (X):</b> videos &amp; voice\n` +
    `${ce(E.facebook, '📘')} <b>Facebook:</b> video\n` +
    `${ce(E.vk, '🔵')} <b>Vk:</b> videos &amp; clips\n` +
    `${ce(E.reddit, '🟠')} <b>Reddit:</b> videos &amp; gifs\n` +
    `${ce(E.twitch, '🟣')} <b>Twitch:</b> clips\n` +
    `${ce(E.vimeo, '🎞')} <b>Vimeo:</b> video\n` +
    `${ce(E.ok, '🟧')} <b>Ok:</b> video\n` +
    `${ce(E.tumblr, '📝')} <b>Tumblr:</b> videos &amp; audio\n` +
    `${ce(E.likee, '❤️')} <b>Likee:</b> videos\n` +
    `${ce(E.soundcloud, '☁️')} <b>Soundcloud</b>\n` +
    `${ce(E.applemusic, '🎶')} <b>Apple Music</b>\n` +
    `${ce(E.spotify, '🟢')} <b>Spotify</b>\n` +
    `${ce(E.threads, '🧵')} <b>Threads</b>\n\n` +
    `${ce(E.star, '⭐')} <b>Subscription:</b> ${subscriptionActive ? 'active' : 'not active'}`;

// Platforms that are not supported yet — shown when "Coming Soon" is tapped
const comingSoonText = () =>
    `⏳ <b>Coming soon!</b>\n\n` +
    `These platforms are on the way:\n\n` +
    `${ce(E.pinterest, '📌')} <b>Pinterest:</b> videos &amp; stories\n` +
    `${ce(E.twitter, '🐦')} <b>Twitter (X):</b> videos &amp; voice\n` +
    `${ce(E.vk, '🔵')} <b>Vk:</b> videos &amp; clips\n` +
    `${ce(E.reddit, '🟠')} <b>Reddit:</b> videos &amp; gifs\n` +
    `${ce(E.twitch, '🟣')} <b>Twitch:</b> clips\n` +
    `${ce(E.vimeo, '🎞')} <b>Vimeo:</b> video\n` +
    `${ce(E.ok, '🟧')} <b>Ok:</b> video\n` +
    `${ce(E.tumblr, '📝')} <b>Tumblr:</b> videos &amp; audio\n` +
    `${ce(E.likee, '❤️')} <b>Likee:</b> videos\n` +
    `${ce(E.soundcloud, '☁️')} <b>Soundcloud</b>\n` +
    `${ce(E.applemusic, '🎶')} <b>Apple Music</b>\n` +
    `${ce(E.spotify, '🟢')} <b>Spotify</b>\n` +
    `${ce(E.threads, '🧵')} <b>Threads</b>\n\n` +
    `${ce(E.star, '⭐')} <b>Stay tuned!</b>`;

// ---------- 4. KEYBOARD ----------
const mainKeyboard = (audioOn = true) => ({
    inline_keyboard: [
        // [btn('Add a bot to the chat', 'addbot', E.addbot)],
        // [btn('Support', 'support', E.support), btn('Change language', 'language', E.language)],
        // [btn(`Send audio: ${audioOn ? 'on' : 'off'}`, 'toggle_audio', E.audio)],
        [btn('What\'s Coming Soon', 'soon', E.star, 'success')],
        [btn('Hide', 'hide', E.hide, 'danger')],
    ],
});


// Greetings
function userGreetings(time) {
    // This function should return a greeting based on the time of day
    const userTime = new Date().getHours();

    if (userTime < 12) {
        return "Good morning!";
    } else if (userTime < 18) {
        return "Good afternoon!";
    } else {
        return "Good evening!";
    }
}

// ─── Platform detection ───────────────────────────────────────────────────────
function detectPlatform(url) {
    if (url.includes('tiktok.com') || url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com') || url.includes('instagr.am')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) return 'facebook';
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    return null;
}

function createDownloadTimeoutError() {
    const error = new Error('Failed to download the video after 2 minutes. Please try again.');
    error.name = 'DownloadTimeoutError';
    return error;
}

function isDownloadTimeoutError(err) {
    return err?.name === 'DownloadTimeoutError';
}

function isAnyTimeoutError(err) {
    const message = (err?.message || '').toLowerCase();
    return (
        err?.code === 'ETIMEDOUT' ||
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('promise timed out')
    );
}

// The yt-dlp binary lives in node_modules and is fetched by a postinstall step.
// When that fetch fails, spawning the missing binary rejects with an ENOENT error
// whose message/stderr/stdout are ALL empty — so it used to surface as a blank
// "yt-dlp error: " and get misreported as an age-restricted video.
function isYtDlpMissingError(err) {
    return err?.code === 'ENOENT' && !err?.message && !err?.stderr && !err?.stdout;
}

function createYtDlpMissingError() {
    const error = new Error(
        'yt-dlp binary is missing. Run `npm install` in backend/, or `node scripts/ensure-ytdlp.mjs`.'
    );
    error.name = 'YtDlpMissingError';
    return error;
}

async function runYtDlp(url, flags, options = YTDLP_TIMEOUT_OPTIONS) {
    try {
        return await youtubeDl(url, { 'js-runtimes': `node:${process.execPath}`, ...flags }, options);
    } catch (err) {
        if (isAnyTimeoutError(err)) throw createDownloadTimeoutError();
        if (isYtDlpMissingError(err)) {
            console.error('yt-dlp binary missing at:', err.path);
            throw createYtDlpMissingError();
        }
        throw err;
    }
}

async function withDownloadTimeout(promise) {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(createDownloadTimeoutError()), DOWNLOAD_TIMEOUT_MS);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

// ─── TikTok downloader (tikwm) ────────────────────────────────────────────────
async function downloadTikTok(url) {
    // Resolve short links
    if (url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) {
        try {
            const response = await axios.get(url, {
                maxRedirects: 0,
                validateStatus: status => status === 301 || status === 302
            });
            if (response.headers.location) url = response.headers.location;
        } catch (err) {
            throw new Error('Failed to resolve short TikTok URL');
        }
    }

    const apiUrl = `https://tikwm.com/api?url=${encodeURIComponent(url)}`;
    const { data } = await axios.get(apiUrl);

    if (data.code !== 0 || !data.data) throw new Error('Could not fetch TikTok (maybe private?)');

    const d = data.data;
    const base = {
        id: d.id,
        title: d.title || 'TikTok',
        region: d.region,
        author: d.author,
        digg_count: d.digg_count,
        comment_count: d.comment_count,
        share_count: d.share_count,
        play_count: d.play_count,
        download_count: d.download_count,
        duration: d.duration,
        create_time: d.create_time,
        origin_cover: d.origin_cover,
        original: d.original,
    };

    if (d.images && d.images.length > 0) {
        return { ...base, type: 'carousel', images: d.images };
    } else if (d.play) {
        // TikTok returns a short-lived, IP-sensitive CDN URL. Telegram's
        // servers frequently cannot retrieve that URL themselves, which made
        // the bot fall back to sending the raw tiktokcdn.com link. Fetch it
        // from this server and upload the resulting file to Telegram instead.
        let download = { file: null, tooLarge: false };

        try {
            download = await prepareVideoFileForTelegram(d.play, url);
        } catch (err) {
            if (isDownloadTimeoutError(err)) throw err;
            // Keep the direct URL as a last resort. This matches the existing
            // Instagram/Facebook behavior when a CDN download cannot be made.
            console.error('TikTok media file download failed:', err.message);
        }

        return {
            ...base,
            type: 'video',
            video: d.play,
            webpage_url: url,
            file: download.file,
            tooLarge: download.tooLarge,
        };
    }

    throw new Error('No media found in this TikTok');
}

// ─── Social-media video temp files ───────────────────────────────────────────
// Social-media CDN links are signed, expire quickly, and are frequently rejected
// when Telegram tries to fetch them itself. Download the media here and upload it
// through the Bot API instead.
async function downloadUrlToTempFile(mediaUrl) {
    const token = `${Date.now()}_${randomUUID()}`;
    const filePath = path.join(os.tmpdir(), `${IG_TEMP_PREFIX}${token}.mp4`);

    try {
        const response = await axios.get(mediaUrl, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            },
            timeout: DOWNLOAD_TIMEOUT_MS,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        await pipeline(response.data, fs.createWriteStream(filePath));

        const contentType = String(response.headers['content-type'] || '');
        if (/^(text\/|application\/json|application\/vnd\.apple\.mpegurl)/i.test(contentType)) {
            await removeYouTubeTempFile(filePath);
            throw new Error(`Media URL returned ${contentType} instead of a video`);
        }

        return filePath;
    } catch (err) {
        await removeYouTubeTempFile(filePath);
        throw err;
    }
}

// Fallback when the resolved format is video-only or the direct CDN download
// fails: let yt-dlp fetch and merge the streams itself.
async function downloadYtDlpVideoToTempFile(url) {
    const token = `${Date.now()}_${randomUUID()}`;
    const prefix = `${IG_TEMP_PREFIX}${token}`;
    const tempDir = os.tmpdir();

    await runYtDlp(url, {
        format: 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/b',
        mergeOutputFormat: 'mp4',
        output: path.join(tempDir, `${prefix}.%(ext)s`),
        noPlaylist: true,
        noWarnings: true,
        addHeader: ['referer:' + url, 'user-agent:Mozilla/5.0'],
    });

    const produced = (await fs.promises.readdir(tempDir))
        .filter(name => name.startsWith(`${prefix}.`) && !name.endsWith('.part'))
        .map(name => path.join(tempDir, name));

    if (produced.length === 0) {
        throw new Error('yt-dlp finished without producing a video file.');
    }

    const withSizes = await Promise.all(produced.map(async filePath => ({
        filePath,
        size: (await fs.promises.stat(filePath)).size,
    })));
    withSizes.sort((a, b) => b.size - a.size);

    for (const extra of withSizes.slice(1)) {
        await removeYouTubeTempFile(extra.filePath);
    }

    return withSizes[0].filePath;
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';

        proc.stderr.on('data', chunk => { stderr += chunk; });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(`ffmpeg exited with ${code}: ${stderr.split('\n').slice(-2).join(' ')}`));
        });
    });
}

// Re-encode a file that is over the 50 MB upload limit, trying progressively
// smaller resolutions/bitrates. Returns the path of a file that fits, or null.
async function compressVideoForTelegram(filePath) {
    const outputPath = filePath.replace(/\.mp4$/i, '') + '_small.mp4';

    for (const step of IG_COMPRESS_STEPS) {
        try {
            await runFfmpeg([
                '-y',
                '-i', filePath,
                '-vf', `scale=-2:'min(${step.maxHeight},ih)'`,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', String(step.crf),
                '-maxrate', `${step.maxRateKbps}k`,
                '-bufsize', `${step.maxRateKbps * 2}k`,
                '-c:a', 'aac',
                '-b:a', `${step.audioKbps}k`,
                '-movflags', '+faststart',
                outputPath,
            ]);
        } catch (err) {
            console.error(`Video compression (${step.maxHeight}p) failed:`, err.message);
            await removeYouTubeTempFile(outputPath);
            return null;
        }

        const { size } = await fs.promises.stat(outputPath).catch(() => ({ size: Infinity }));

        if (size <= TELEGRAM_UPLOAD_LIMIT_BYTES) return outputPath;

        await removeYouTubeTempFile(outputPath);
    }

    return null;
}

async function ensureTelegramSize(filePath) {
    const { size } = await fs.promises.stat(filePath);

    if (size <= TELEGRAM_UPLOAD_LIMIT_BYTES) {
        return { file: filePath, tooLarge: false };
    }

    console.warn(
        `Media file is ${(size / 1024 / 1024).toFixed(1)} MB ` +
        `(limit ${TELEGRAM_UPLOAD_LIMIT_BYTES / 1024 / 1024} MB), compressing`
    );

    const compressed = await compressVideoForTelegram(filePath);
    await removeYouTubeTempFile(filePath);

    return compressed
        ? { file: compressed, tooLarge: false }
        : { file: null, tooLarge: true };
}

async function prepareVideoFileForTelegram(videoUrl, pageUrl) {
    let filePath;

    try {
        filePath = await downloadUrlToTempFile(videoUrl);
    } catch (err) {
        if (isAnyTimeoutError(err)) throw createDownloadTimeoutError();
        console.error('Direct media download failed, retrying with yt-dlp:', err.message);
        filePath = await downloadYtDlpVideoToTempFile(pageUrl);
    }

    return ensureTelegramSize(filePath);
}

async function prepareVideoFileFromYtDlp(pageUrl) {
    return ensureTelegramSize(await downloadYtDlpVideoToTempFile(pageUrl));
}

// Captions longer than Telegram's 1024-character limit make sendVideo fail
// outright, which used to surface as the "video too large" link fallback.
function buildVideoCaption(title) {
    const suffix = '\n\nTiktok Downloader Bot Developed by Grealishgit';
    const prefix = '🎬 ';
    const normalized = String(title || 'Video').replace(/\s+/g, ' ').trim();
    const room = TELEGRAM_CAPTION_LIMIT - prefix.length - suffix.length;
    const text = normalized.length > room
        ? `${normalized.slice(0, Math.max(0, room - 1))}…`
        : normalized;

    return `${prefix}${text}${suffix}`;
}

// ─── Instagram / Facebook downloader (yt-dlp) ────────────────────────────────
async function downloadWithYtDlp(url) {
    try {
        // First, get info without downloading
        const info = await runYtDlp(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            addHeader: ['referer:' + url, 'user-agent:Mozilla/5.0'],
        });

        // Handle playlist / multi-image (Instagram carousel)
        if (info.entries && info.entries.length > 0) {
            const images = [];
            const videos = [];

            for (const entry of info.entries) {
                if (entry.ext === 'jpg' || entry.ext === 'png' || entry.ext === 'webp'
                    || (entry.thumbnail && !entry.url?.includes('.mp4'))) {
                    images.push(entry.url || entry.thumbnail);
                } else {
                    videos.push(entry.url);
                }
            }

            if (images.length > 0) {
                return {
                    type: 'carousel',
                    images,
                    title: info.title || 'Post',
                    author: info.uploader || info.channel || null,
                };
            }

            if (videos.length > 0) {
                let download = { file: null, tooLarge: false };

                try {
                    download = await prepareVideoFileForTelegram(videos[0], url);
                } catch (err) {
                    if (isDownloadTimeoutError(err)) throw err;
                    console.error('Carousel video download failed:', err.message);
                }

                return {
                    type: 'video',
                    video: videos[0],
                    webpage_url: url,
                    file: download.file,
                    tooLarge: download.tooLarge,
                    title: info.title || 'Video',
                    author: info.uploader || info.channel || null,
                };
            }
        }

        // Single media
        const isImage = info.ext === 'jpg' || info.ext === 'png'
            || info.ext === 'webp' || info.vcodec === 'none';

        if (isImage) {
            return {
                type: 'carousel',
                images: [info.url || info.thumbnail],
                title: info.title || 'Image',
                author: info.uploader || null,
            };
        }

        // Get best video URL
        let videoUrl = info.url;
        let needsAudioMerge = false;

        if (!videoUrl && info.formats) {
            // Pick the best mp4 format that already has audio; fall back to a
            // video-only stream (merged with audio by yt-dlp) only when there is
            // no combined format at all.
            const mp4Formats = info.formats.filter(f => f.ext === 'mp4' && f.vcodec !== 'none');
            const combined = mp4Formats.filter(f => f.acodec && f.acodec !== 'none');
            const fmt = combined.sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0]
                || mp4Formats.sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0]
                || info.formats[info.formats.length - 1];
            videoUrl = fmt?.url;
            needsAudioMerge = Boolean(videoUrl && (!fmt?.acodec || fmt.acodec === 'none'));
        }

        if (!videoUrl) throw new Error('No downloadable URL found');

        // Telegram cannot reliably fetch these CDN links itself and sending by
        // URL is capped at 20 MB, so download the file and upload it (50 MB).
        // HLS streams and video-only formats have to go through yt-dlp.
        const isHls = /m3u8/i.test(info.protocol || '') || /\.m3u8(\?|$)/i.test(videoUrl);
        let download = { file: null, tooLarge: false };

        try {
            download = needsAudioMerge || isHls
                ? await prepareVideoFileFromYtDlp(url)
                : await prepareVideoFileForTelegram(videoUrl, url);
        } catch (err) {
            if (isDownloadTimeoutError(err)) throw err;
            console.error('Media file download failed:', err.message);
        }

        return {
            type: 'video',
            video: videoUrl,
            webpage_url: url,
            file: download.file,
            tooLarge: download.tooLarge,
            title: info.title || 'Video',
            author: info.uploader || info.channel || null,
            duration: info.duration || null,
        };

    } catch (err) {
        if (isDownloadTimeoutError(err)) throw err;
        console.error('yt-dlp error:', err.message);
        throw new Error('Could not fetch media. The post may be private or unsupported.');
    }
}


function getYouTubeCookieFlags() {
    const cookiesPath = process.env.YTDLP_COOKIES_PATH;
    const cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
    const flags = {};

    if (cookiesPath) flags.cookies = cookiesPath;
    if (cookiesFromBrowser) flags['cookies-from-browser'] = cookiesFromBrowser;

    return flags;
}

function isYouTubeBotCheckError(err) {
    const message = (err?.message || '').toLowerCase();
    return (
        message.includes('sign in to confirm') ||
        message.includes('not a bot') ||
        message.includes('use --cookies-from-browser') ||
        message.includes('use --cookies')
    );
}

// ─── YouTube temp files ──────────────────────────────────────────────────────
async function removeYouTubeTempFile(filePath) {
    if (!filePath) return;

    try {
        await fs.promises.unlink(filePath);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not delete temp file:', err.message);
    }
}

async function cleanupStaleTempFiles() {
    let entries;

    try {
        entries = await fs.promises.readdir(os.tmpdir());
    } catch (err) {
        console.error('Temp cleanup scan failed:', err.message);
        return;
    }

    const cutoff = Date.now() - YT_TEMP_MAX_AGE_MS;
    let removed = 0;

    for (const name of entries) {
        if (!MEDIA_TEMP_PREFIXES.some(prefix => name.startsWith(prefix))) continue;

        const filePath = path.join(os.tmpdir(), name);

        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
                await fs.promises.unlink(filePath);
                removed += 1;
            }
        } catch (err) {
            if (err.code !== 'ENOENT') console.error('Temp cleanup error:', err.message);
        }
    }

    if (removed > 0) console.log(`Removed ${removed} stale temp file(s)`);
}

// Cap simultaneous YouTube downloads so the small server is not overloaded.
let activeYouTubeDownloads = 0;
const youTubeDownloadQueue = [];

function acquireYouTubeDownloadSlot() {
    if (activeYouTubeDownloads < YT_MAX_CONCURRENT_DOWNLOADS) {
        activeYouTubeDownloads += 1;
        return Promise.resolve();
    }

    return new Promise(resolve => youTubeDownloadQueue.push(resolve));
}

function releaseYouTubeDownloadSlot() {
    const next = youTubeDownloadQueue.shift();

    if (next) {
        next(); // hand the slot straight over; the count stays the same
        return;
    }

    activeYouTubeDownloads = Math.max(0, activeYouTubeDownloads - 1);
}

function buildVideoProxyUrl(filePath) {
    const base = (BACKEND_URL || '').replace(/\/$/, '');
    return `${base}/api/video?file=${encodeURIComponent(path.basename(filePath))}`;
}

// Telegraf's multipart uploads are chunked, and Telegram closes the connection
// on them ("socket hang up"). Upload through axios with an explicit
// Content-Length computed from the file size instead.
async function sendVideoFileToChat(ctx, filePath, caption) {
    const { size } = await fs.promises.stat(filePath);
    const form = new FormData();

    form.append('chat_id', String(ctx.chat.id));
    form.append('video', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        contentType: 'video/mp4',
        knownLength: size,
    });
    form.append('caption', caption);
    form.append('supports_streaming', 'true');

    const markup = getAdminContactMarkup();
    if (markup?.reply_markup) form.append('reply_markup', JSON.stringify(markup.reply_markup));

    const apiRoot = (bot.telegram.options?.apiRoot || 'https://api.telegram.org').replace(/\/$/, '');
    const { data } = await axios.post(
        `${apiRoot}/bot${bot.telegram.token}/sendVideo`,
        form,
        {
            headers: { ...form.getHeaders(), 'Content-Length': form.getLengthSync() },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 5 * 60 * 1000,
        }
    );

    if (!data?.ok) throw new Error(data?.description || 'Telegram rejected the video upload');

    return data.result;
}


// Fetch metadata once before either presenting the quality selector or
// downloading. Keeping this separate prevents a button click from having to
// rediscover the same video formats.
async function getYouTubeInfo(url) {
    const metadataFlags = {
        // Without dumpSingleJson yt-dlp downloads the file and returns progress
        // text instead of JSON, so info.formats is undefined.
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificate: true,
        // NOTE: deliberately no `format` flag. A selector here makes yt-dlp
        // hard-fail with "Requested format is not available" on videos lacking a
        // combined stream, even though all we need is the JSON.
    };

    const configuredCookieFlags = getYouTubeCookieFlags();
    let info;

    try {
        info = await runYtDlp(url, metadataFlags);
    } catch (err) {
        if (isDownloadTimeoutError(err)) throw err;
        if (err?.name === 'YtDlpMissingError') throw err;

        if (!isYouTubeBotCheckError(err)) {
            console.error('YouTube yt-dlp error:', err.message || err.stderr || err);
            throw new Error('Could not fetch YouTube video. It may be age-restricted or unavailable.');
        }

        const cookieAttempts = Object.keys(configuredCookieFlags).length > 0
            ? [{ label: 'configured cookies', flags: configuredCookieFlags }]
            : [
                { label: 'browser cookies (chrome)', flags: { 'cookies-from-browser': 'chrome' } },
                { label: 'browser cookies (edge)', flags: { 'cookies-from-browser': 'edge' } },
            ];

        let retried = false;

        for (const attempt of cookieAttempts) {
            try {
                info = await runYtDlp(url, {
                    ...metadataFlags,
                    ...attempt.flags,
                });

                retried = true;
                break;
            } catch (retryErr) {
                if (isDownloadTimeoutError(retryErr)) throw retryErr;
                if (retryErr?.name === 'YtDlpMissingError') throw retryErr;
                console.error(`YouTube yt-dlp ${attempt.label} retry error:`, retryErr.message || retryErr.stderr || retryErr);
            }
        }

        if (!retried || !info) {
            if (Object.keys(configuredCookieFlags).length > 0) {
                throw new Error('Could not fetch YouTube video with configured cookies. Refresh cookies and retry.');
            }

            throw new Error('YouTube asked for bot verification. Automatic browser-cookie retry failed. Set YTDLP_COOKIES_FROM_BROWSER (example: chrome) or YTDLP_COOKIES_PATH in backend/.env and retry.');
        }
    }

    return { info, configuredCookieFlags };
}

function getYouTubeQualityOptions(info) {
    const videos = (info.formats || [])
        .filter(format =>
            format.url &&
            format.protocol !== 'mhtml' &&
            format.vcodec !== 'none' &&
            Number.isFinite(format.height) &&
            format.height > 0 &&
            format.height <= YT_MAX_SELECTABLE_HEIGHT
        );

    // Prefer MP4 choices because the resulting video is most compatible with
    // Telegram, but keep other formats as a fallback when MP4 is unavailable.
    const compatibleVideos = videos.filter(format => format.ext === 'mp4');
    const heights = [...new Set((compatibleVideos.length ? compatibleVideos : videos)
        .map(format => format.height))]
        .sort((a, b) => b - a);

    return heights.filter(height => {
        const estimated = estimateYouTubeSizeBytes(info, height);

        if (estimated && estimated > TELEGRAM_UPLOAD_LIMIT_BYTES) {
            console.warn(
                `Not offering YouTube ${height}p: estimated ${(estimated / 1024 / 1024).toFixed(1)} MB ` +
                `(limit ${TELEGRAM_UPLOAD_LIMIT_BYTES / 1024 / 1024} MB)`
            );
            return false;
        }

        return true;
    });
}

async function downloadYouTube(url, { metadataOnly = false } = {}) {
    const { info, configuredCookieFlags } = await getYouTubeInfo(url);

    // YouTube playlists
    if (info.entries && info.entries.length > 0) {
        return {
            type: 'playlist',
            title: info.title || 'YouTube Playlist',
            count: info.entries.length,
            entries: info.entries.map(e => ({
                title: e.title,
                url: e.webpage_url || e.url,
                duration: e.duration,
                thumbnail: e.thumbnail,
            }))
        };
    }

    const metadata = {
        title: info.title || 'YouTube Video',
        author: info.uploader || info.channel || null,
        duration: info.duration || null,
        thumbnail: info.thumbnail || null,
        view_count: info.view_count || null,
        like_count: info.like_count || null,
        upload_date: info.upload_date || null,
    };

    const watchUrl = info.webpage_url || url;

    if (metadataOnly) {
        return {
            type: 'quality_selection',
            title: metadata.title,
            webpage_url: watchUrl,
            qualities: getYouTubeQualityOptions(info),
            // This is only retained in the in-memory callback state; it is
            // never returned from an API route or sent to Telegram.
            cookieFlags: configuredCookieFlags,
        };
    }

    const qualitySteps = YT_QUALITY_STEPS.filter(height => {
        const estimated = estimateYouTubeSizeBytes(info, height);

        if (estimated && estimated > TELEGRAM_UPLOAD_LIMIT_BYTES) {
            console.warn(
                `Skipping YouTube ${height}p: estimated ${(estimated / 1024 / 1024).toFixed(1)} MB ` +
                `(limit ${TELEGRAM_UPLOAD_LIMIT_BYTES / 1024 / 1024} MB)`
            );
            return false;
        }

        return true;
    });

    const downloaded = await downloadYouTubeVideoFile(watchUrl, configuredCookieFlags, qualitySteps);

    if (!downloaded) {
        return {
            type: 'video',
            video: watchUrl,
            webpage_url: watchUrl,
            file: null,
            tooLarge: true,
            ...metadata,
        };
    }

    return {
        type: 'video',
        video: buildVideoProxyUrl(downloaded.file),
        webpage_url: watchUrl,
        file: downloaded.file,
        height: downloaded.height,
        ...metadata,
    };
}

// Rough merged-size estimate (video-only mp4 + m4a audio) used to skip
// qualities that would obviously exceed the upload limit. Returns null when the
// sizes are unknown, in which case we just try the download.
function estimateYouTubeSizeBytes(info, height) {
    const formats = (info.formats || []).filter(f => f.url && f.protocol !== 'mhtml');
    const allVideos = formats
        .filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.ext === 'mp4' && f.height && f.height <= height);
    const avcVideos = allVideos.filter(f => String(f.vcodec).startsWith('avc1'));
    const videos = (avcVideos.length > 0 ? avcVideos : allVideos)
        .sort((a, b) => b.height - a.height || (b.tbr || 0) - (a.tbr || 0));
    const audios = formats
        .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.ext === 'm4a')
        .sort((a, b) => (b.tbr || 0) - (a.tbr || 0));

    const videoSize = videos[0]?.filesize || videos[0]?.filesize_approx || null;
    const audioSize = audios[0]?.filesize || audios[0]?.filesize_approx || null;

    return videoSize && audioSize ? videoSize + audioSize : null;
}

// Download at the requested quality (or the best automatic fallback) while
// respecting Telegram's upload limit. Returns { file, height } or null when
// every attempted quality is too large.
async function downloadYouTubeVideoFile(url, cookieFlags, qualitySteps = YT_QUALITY_STEPS, strictQuality = false) {
    await acquireYouTubeDownloadSlot();

    let lastError = null;

    try {
        for (const height of qualitySteps) {
            let filePath;

            try {
                filePath = await downloadYouTubeFile(url, height, cookieFlags, strictQuality);
            } catch (err) {
                if (isDownloadTimeoutError(err)) throw err;
                if (err?.name === 'YtDlpMissingError') throw err;
                console.error(`YouTube ${height}p download failed:`, err.message || err.stderr || err);
                lastError = err;
                continue;
            }

            const { size } = await fs.promises.stat(filePath);

            if (size <= TELEGRAM_UPLOAD_LIMIT_BYTES) {
                return { file: filePath, height };
            }

            await removeYouTubeTempFile(filePath);
            console.warn(
                `YouTube ${height}p file is ${(size / 1024 / 1024).toFixed(1)} MB ` +
                `(limit ${TELEGRAM_UPLOAD_LIMIT_BYTES / 1024 / 1024} MB), retrying lower quality`
            );
        }
    } finally {
        releaseYouTubeDownloadSlot();
    }

    if (lastError) throw lastError;

    return null;
}

async function downloadYouTubeFile(url, height, cookieFlags, strictQuality = false) {
    const token = `${Date.now()}_${randomUUID()}`;
    const prefix = `${YT_TEMP_PREFIX}${token}`;
    const tempDir = os.tmpdir();

    const flags = {
        // Prefer H.264 + AAC so ffmpeg can merge without re-encoding and every
        // Telegram client can play the result (AV1 mp4 is not universal).
        // Then fall back to any mp4 video, then a progressive combined mp4,
        // then anything at or below the height cap.
        format: strictQuality
            ? [
                `bv*[height=${height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]`,
                `bv*[height=${height}][ext=mp4]+ba[ext=m4a]`,
                `b[ext=mp4][height=${height}]`,
                `b[height=${height}]`,
            ].join('/')
            : [
                `bv*[height<=${height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]`,
                `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
                `b[ext=mp4][height<=${height}]`,
                `b[height<=${height}]`,
                `b`,
            ].join('/'),
        mergeOutputFormat: 'mp4',
        output: path.join(tempDir, `${prefix}.%(ext)s`),
        noPlaylist: true,
        noWarnings: true,
        ...cookieFlags,
    };

    try {
        await runYtDlp(url, flags);
    } catch (err) {
        // Remove whatever this attempt left behind (e.g. a .part file).
        const leftovers = (await fs.promises.readdir(tempDir))
            .filter(name => name.startsWith(`${prefix}.`))
            .map(name => path.join(tempDir, name));

        await Promise.all(leftovers.map(removeYouTubeTempFile));
        throw err;
    }

    const produced = (await fs.promises.readdir(tempDir))
        .filter(name => name.startsWith(`${prefix}.`) && !name.endsWith('.part'))
        .map(name => path.join(tempDir, name));

    if (produced.length === 0) {
        throw new Error('yt-dlp finished without producing a video file.');
    }

    // Normally there is exactly one file; if not, keep the largest.
    const withSizes = await Promise.all(produced.map(async filePath => ({
        filePath,
        size: (await fs.promises.stat(filePath)).size,
    })));
    withSizes.sort((a, b) => b.size - a.size);

    for (const extra of withSizes.slice(1)) {
        await removeYouTubeTempFile(extra.filePath);
    }

    return withSizes[0].filePath;
}


// ─── Master download function ─────────────────────────────────────────────────
async function downloadMedia(url) {
    const platform = detectPlatform(url);
    if (!platform) throw new Error('Unsupported platform. Send a TikTok, Instagram, Facebook, or YouTube link.');

    if (platform === 'tiktok') return downloadTikTok(url);
    if (platform === 'youtube') return downloadYouTube(url);
    return downloadWithYtDlp(url);
}

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TOKEN, { handlerTimeout: BOT_HANDLER_TIMEOUT_MS });
const adminUsername = process.env.ADMIN_USERNAME?.replace(/^@/, '') || '';

function isAdmin(ctx) {
    return Boolean(
        adminUsername &&
        ctx.from?.username?.toLowerCase() === adminUsername.toLowerCase()
    );
}

function getAdminContactMarkup() {
    if (!adminUsername) return undefined;

    return Markup.inlineKeyboard([
        [Markup.button.url('Need a bot? Contact Developer Here', `https://t.me/${adminUsername}`)]
    ]);
}

function pruneExpiredYouTubeQualitySelections() {
    const cutoff = Date.now() - YT_QUALITY_SELECTION_TTL_MS;

    for (const [token, selection] of pendingYouTubeQualitySelections) {
        if (selection.createdAt < cutoff) pendingYouTubeQualitySelections.delete(token);
    }
}

function createYouTubeQualityKeyboard(token, qualities) {
    const buttons = qualities.map(height => ({
        text: `${height}p`,
        callback_data: `ytq:${token}:${height}`,
    }));
    const rows = [];

    for (let index = 0; index < buttons.length; index += 3) {
        rows.push(buttons.slice(index, index + 3));
    }

    rows.push([{ text: 'Cancel', callback_data: `ytq:${token}:cancel` }]);
    return { inline_keyboard: rows };
}

async function sendVideoResultToChat(ctx, result) {
    if (result.file) {
        try {
            await sendVideoFileToChat(ctx, result.file, buildVideoCaption(result.title));
            console.log(`Sent video file${result.height ? ` (<=${result.height}p)` : ''}: ${result.title}`);
        } catch (videoErr) {
            console.error('Video upload failed:', videoErr.message);
            await ctx.reply(
                `⚠️ Could not send the video file.\n\n` +
                `🔗 Watch it here:\n${result.webpage_url || result.video}`,
                getAdminContactMarkup()
            );
        } finally {
            await removeYouTubeTempFile(result.file);
        }
        return;
    }

    if (result.tooLarge) {
        await ctx.reply(
            `⚠️ This video is too large for Telegram (bot upload limit is 50 MB).\n\n` +
            `🔗 Watch it here:\n${result.webpage_url || result.video}`,
            getAdminContactMarkup()
        );
        return;
    }

    try {
        await ctx.replyWithVideo(
            { url: result.video },
            { caption: buildVideoCaption(result.title), ...getAdminContactMarkup() }
        );
    } catch (videoErr) {
        console.error('Video send failed:', videoErr.message);
        await ctx.reply(
            `⚠️ Could not send the video directly.\n\n` +
            `🔗 Watch it here:\n${result.webpage_url || result.video}`,
            getAdminContactMarkup()
        );
    }
}

bot.catch(async (err, ctx) => {
    console.error('Unhandled bot middleware error:', err.message);

    if (ctx?.reply) {
        const fallbackMessage = isAnyTimeoutError(err) || isDownloadTimeoutError(err)
            ? 'Failed to download the video after 2 minutes. Please try again.'
            : 'Failed to process your request. Please try again.';

        try {
            await ctx.reply(fallbackMessage);
        } catch (replyErr) {
            console.error('Failed to send fallback error message:', replyErr.message);
        }
    }
});

// bot.start(async (ctx) => {
//     const name = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "there";

//     try {
//         await ctx.reply(
//             `👋 ${userGreetings()} ${name}\n\n` +
//             `Send me a link from any of the following sources and I'll download it for you! \n\n` +
//             `🎵 TikTok\n📸 Instagram\n📘 Facebook\n▶️ YouTube\n\n`
//         );
//     } catch (err) {
//         console.error('Start command error:', err.message);
//         try {
//             await ctx.reply(`👋 ${userGreetings()} ${name} Send me a TikTok, Instagram, Facebook or YouTube link!`);
//         } catch (replyErr) {
//             console.error('Start command reply error:', replyErr.message);
//         }
//     }
// });



// ---------- 1. ICON IDS (replace these one by one) ----------


// ---------- 5. HANDLERS ----------
bot.start(async (ctx) => {
    const name = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'there';
    try {
        await ctx.reply(
            `👋 ${esc(userGreetings())} ${esc(name)}\n\n` +
            `This bot downloads videos/photos/audio from popular social networks through copied links!\n\n` +
                `How to use\n` +
            `1. Open one of the social networks\n.` +
            `2. Choose the video/photo you are interested with.\n` +
            `3. Tap the "Copy link" or "Share" button.\n` +
            `4. Send the 🔗 link to the bot and get the downloaded file.\n\n` +
            `Note: The bot will automatically detect the type of content and download it accordingly.\n\n` +

            ` The bot can download media from:\n` +
                `${ce(E.tiktok, '🎵')} TikTok\n` +
            `${ce(E.instagram, '📸')} Instagram\n` +
            `${ce(E.facebook, '📘')} Facebook\n` +
            `${ce(E.youtube, '▶️')} YouTube\n\n` +

            `Completely free, No limits. Enjoy !`,
            { parse_mode: 'HTML', reply_markup: mainKeyboard(true) }
        );
    } catch (err) {
        console.error('start error:', err.message);
    }
});

bot.command('options', async (ctx) => {
    try {
        await ctx.reply(optionsText(false), {
            parse_mode: 'HTML',
            reply_markup: mainKeyboard(true),
        });
    } catch (err) {
        console.error('options error:', err.message);
    }
});

bot.action('hide', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => { });
});

bot.action('soon', async (ctx) => {
    try {
        await ctx.answerCbQuery('Coming soon!');
        await ctx.reply(comingSoonText(), {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[btn('Hide', 'hide', E.hide, 'danger')]],
            },
        });
    } catch (err) {
        console.error('soon error:', err.message);
    }
});

bot.action(/^ytq:([0-9a-f]{12}):(\d+|cancel)$/, async (ctx) => {
    const [, token, choice] = ctx.match;
    const selection = pendingYouTubeQualitySelections.get(token);

    if (!selection || Date.now() - selection.createdAt > YT_QUALITY_SELECTION_TTL_MS) {
        pendingYouTubeQualitySelections.delete(token);
        await ctx.answerCbQuery('This quality menu has expired. Send the YouTube link again.', { show_alert: true });
        return;
    }

    if (selection.chatId !== ctx.chat?.id || selection.userId !== ctx.from?.id) {
        await ctx.answerCbQuery('This quality menu belongs to another user.', { show_alert: true });
        return;
    }

    if (choice === 'cancel') {
        pendingYouTubeQualitySelections.delete(token);
        await ctx.answerCbQuery('Cancelled');
        await ctx.deleteMessage().catch(() => { });
        return;
    }

    const height = Number(choice);
    if (!selection.qualities.includes(height)) {
        await ctx.answerCbQuery('That quality is no longer available. Send the link again.', { show_alert: true });
        return;
    }

    // Remove it before downloading so repeated taps cannot start duplicate
    // yt-dlp processes for the same request.
    pendingYouTubeQualitySelections.delete(token);
    await ctx.answerCbQuery(`Downloading ${height}p…`);
    await ctx.editMessageText(`▶️ Downloading ${height}p, please wait...`).catch(() => { });

    try {
        const downloaded = await withDownloadTimeout(
            downloadYouTubeVideoFile(selection.watchUrl, selection.cookieFlags, [height], true)
        );
        const result = downloaded
            ? {
                type: 'video',
                title: selection.title,
                webpage_url: selection.watchUrl,
                video: buildVideoProxyUrl(downloaded.file),
                file: downloaded.file,
                height,
            }
            : {
                type: 'video',
                title: selection.title,
                webpage_url: selection.watchUrl,
                video: selection.watchUrl,
                file: null,
                tooLarge: true,
                height,
            };

        await ctx.deleteMessage().catch(() => { });
        await sendVideoResultToChat(ctx, result);
    } catch (err) {
        console.error(`YouTube ${height}p selection failed:`, err.message || err.stderr || err);
        const message = isDownloadTimeoutError(err) || isAnyTimeoutError(err)
            ? 'Failed to download the video after 2 minutes. Please try again.'
            : `Could not download the ${height}p version. Please send the link again and choose another quality.`;
        await ctx.editMessageText(`⚠️ ${message}`).catch(() => ctx.reply(`⚠️ ${message}`));
    }
});

bot.command('emojiids', async (ctx) => {
    const set = await ctx.telegram.getStickerSet('savedtiktoka_by_emoji_saverbot');
    const lines = set.stickers.map(s => `${s.emoji} ${s.custom_emoji_id}`);
    await ctx.reply(lines.join('\n').slice(0, 4000));
});


bot.command('showpack', async (ctx) => {
    const set = await ctx.telegram.getStickerSet(PACK);
    const items = set.stickers.map((s, i) => ({ n: i + 1, id: s.custom_emoji_id, fb: s.emoji }));

    // 40 per message stays under Telegram's entity and length limits
    for (let i = 0; i < items.length; i += 40) {
        const chunk = items.slice(i, i + 40);
        const text = chunk
            .map(x => `${x.n}. <tg-emoji emoji-id="${x.id}">${x.fb}</tg-emoji> <code>${x.id}</code>`)
            .join('\n');
        await ctx.reply(text, { parse_mode: 'HTML' });
    }
});

bot.command('logos', async (ctx) => {
    const set = await ctx.telegram.getStickerSet('savedtiktoka_by_emoji_saverbot');
    const want = new Set(['🌐', '🎧', '🎵', '📸', '📺', '🔴', '🎬', '📹', '💬', '👤', '🔗']);
    const items = set.stickers
        .map((s, i) => ({ n: i + 1, id: s.custom_emoji_id, fb: s.emoji }))
        .filter(x => want.has(x.fb));

    for (let i = 0; i < items.length; i += 20) {
        const text = items.slice(i, i + 20)
            .map(x => `${x.n}. <tg-emoji emoji-id="${x.id}">${x.fb}</tg-emoji> <code>${x.id}</code>`)
            .join('\n');
        await ctx.reply(text, { parse_mode: 'HTML' });
    }
});

bot.on('text', async (ctx, next) => {
    if (ctx.message.text.trim().startsWith('/')) {
        return next();
    }

    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const firstName = ctx.from.first_name;

        // Save to DB (upsert = insert if not exists, update if exists)
        await User.findOneAndUpdate(
            { telegramId: userId },
            {
                telegramId: userId,
                username,
                firstName,
                lastActive: new Date(),
                $inc: { messageCount: 1 }, // increment usage count
                $setOnInsert: { joinedAt: new Date() } // only set on first insert
            },
            { upsert: true, returnDocument: 'after' }
        );

        const url = ctx.message.text.trim();
        const platform = detectPlatform(url);

        if (!platform) {
            await ctx.reply('Please send a valid TikTok, Instagram, Facebook, or YouTube link.');
            return;
        }

        let result;

        if (platform === 'youtube') {
            await ctx.reply('▶️ Finding available YouTube qualities, please wait...');
            const selection = await withDownloadTimeout(downloadYouTube(url, { metadataOnly: true }));

            if (selection.type === 'quality_selection' && selection.qualities.length > 0) {
                pruneExpiredYouTubeQualitySelections();
                const token = randomUUID().replace(/-/g, '').slice(0, 12);
                pendingYouTubeQualitySelections.set(token, {
                    chatId: ctx.chat.id,
                    userId: ctx.from.id,
                    title: selection.title,
                    watchUrl: selection.webpage_url,
                    cookieFlags: selection.cookieFlags,
                    qualities: selection.qualities,
                    createdAt: Date.now(),
                });

                await ctx.reply(
                    `▶️ ${selection.title}\n\nChoose the video quality you want:`,
                    { reply_markup: createYouTubeQualityKeyboard(token, selection.qualities) }
                );
                return;
            }

            // Playlists are already fully described by the metadata request.
            // A video with no usable format is retried through the regular
            // downloader so it can use yt-dlp's fallback selector.
            result = selection.type === 'playlist'
                ? selection
                : await withDownloadTimeout(downloadYouTube(url));
        } else {
            const platformEmoji = { tiktok: '🎵', instagram: '📸', facebook: '📘' }[platform];
            await ctx.reply(`${platformEmoji} Fetching your ${platform} media, please wait...`);
            result = await withDownloadTimeout(downloadMedia(url));
        }

        if (result.type === 'carousel') {
            const images = result.images;
            const maxPerGroup = 10;

            for (let i = 0; i < images.length; i += maxPerGroup) {
                const chunk = images.slice(i, i + maxPerGroup);
                const media = chunk.map((imageUrl, index) => ({
                    type: 'photo',
                    media: imageUrl,
                    caption: (i === 0 && index === 0)
                        ? `📸 ${result.title}\n\nTiktok Downloader Bot Developed by Grealishgit`
                        : undefined
                }));

                try {
                    await ctx.replyWithMediaGroup(media);
                    if (i + maxPerGroup < images.length) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } catch (groupErr) {
                    console.error('Media group failed, sending individually:', groupErr.message);
                    for (const imgUrl of chunk) {
                        try {
                            await ctx.replyWithPhoto(imgUrl);
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch (photoErr) {
                            console.error('Individual photo failed:', photoErr.message);
                        }
                    }
                }
            }

            await ctx.reply('Want your own downloader bot?', getAdminContactMarkup());

        } else if (result.type === 'video') {
            await sendVideoResultToChat(ctx, result);
        } else if (result.type === 'playlist') {
            // Telegram can't bulk-send a playlist, so send a summary with links
            const lines = result.entries.slice(0, 20).map((e, i) =>
                `${i + 1}. ${e.title} — ${e.url}`
            );
            const truncated = result.entries.length > 20
                ? `\n\n...and ${result.entries.length - 20} more.` : '';

            await ctx.reply(
                `▶️ Playlist: ${result.title} (${result.count} videos)\n\n` +
                lines.join('\n') + truncated,
                getAdminContactMarkup()
            );
        }

    } catch (err) {
        console.error('Bot error:', err.message);
        try {
            await ctx.reply('Failed to download media, try again later');
        } catch (replyErr) {
            console.error('Bot reply error:', replyErr.message);
        }
    }
});

bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { total, monthly } = await getBotStats();
    const name = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'there';
    await ctx.reply(
        // `Hey ${adminUsername}!\n` +
        `Hey Admin!\n` +
        `The bot is running smoothly Here are the bot stats.\n\n` +
        `Bot Stats:\n` +
        `👥 ${total.toLocaleString()} total users\n` +
        `📅 ${monthly.toLocaleString()} joined this month`
    );
});

bot.command('link', async (ctx) => {
    const name = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'there';
    await ctx.reply(`Hey ${adminUsername}!\nPlease resend the link to intiate the download.`);
});

bot.command('uptime', async (ctx) => {
    if (!isAdmin(ctx)) return;

    const totalSeconds = Math.floor(process.uptime());
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const uptime = `${days}d ${hours}h ${minutes}m ${seconds}s`;

    await ctx.reply(`Bot has been up running smoothly for: ${uptime}`);
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
        await ctx.reply('Unrecognized command. Say what?');
    }
});

// ─── API Routes ──────

// General download endpoint — all platforms
app.post('/api/download', async (req, res) => {
    try {
        const url = req.body?.url;
        if (!url) return res.status(400).json({ error: 'Please provide a URL' });

        const platform = detectPlatform(url);
        if (!platform) return res.status(400).json({ error: 'Unsupported platform' });

        const result = await downloadMedia(url);
        // `file` is a server-side temp path used by the bot; API clients use `video`.
        const { file, ...publicResult } = result;
        res.json({
            platform,
            adminUsername: process.env.ADMIN_USERNAME || '',
            ...publicResult
        });

    } catch (error) {
        console.error('Download error:', error.message);
        res.status(500).json({ error: error.message || 'Server error while downloading' });
    }
});

// TikTok video only
app.post('/api/download/video', async (req, res) => {
    try {
        const url = req.body?.url;
        if (!url || !url.includes('tiktok.com')) {
            return res.status(400).json({
                error: 'Please provide a valid TikTok URL'
            });
        }
        const result = await downloadTikTok(url);
        if (result.type !== 'video') return res.status(404).json({ error: 'Not a video post' });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// TikTok carousel only
app.post('/api/download/carousel', async (req, res) => {
    try {
        const url = req.body?.url;
        if (!url || !url.includes('tiktok.com')) {
            return res.status(400).json({ error: 'Please provide a valid TikTok URL' });
        }
        const result = await downloadTikTok(url);
        if (result.type !== 'carousel') return res.status(404).json({ error: 'Not a carousel post' });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Image proxy (bypass CORS)
app.get('/api/image', async (req, res) => {
    try {
        const imageUrl = req.query.url;
        if (!imageUrl) return res.status(400).json({ error: 'Image URL required' });

        const response = await axios.get(imageUrl, {
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        response.data.pipe(res);

    } catch (error) {
        console.error('Image proxy error:', error.message);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// Video proxy (bypass CORS)
app.get('/api/video', async (req, res) => {
    // Locally downloaded YouTube files (see downloadYouTube) are served from the
    // temp directory. Only yt_* files are allowed.
    const requestedFile = req.query.file;

    if (requestedFile) {
        const fileName = path.basename(String(requestedFile));

        if (!MEDIA_TEMP_PREFIXES.some(prefix => fileName.startsWith(prefix))) {
            return res.status(400).json({ error: 'Invalid file' });
        }

        const filePath = path.join(os.tmpdir(), fileName);

        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) throw new Error('not a file');

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'public, max-age=3600');

            const range = req.headers.range;

            if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                const start = match && match[1] ? Number(match[1]) : 0;
                const end = match && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;

                if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
                    res.setHeader('Content-Range', `bytes */${stat.size}`);
                    return res.status(416).end();
                }

                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
                res.setHeader('Content-Length', end - start + 1);
                fs.createReadStream(filePath, { start, end }).pipe(res);
                return;
            }

            res.setHeader('Content-Length', stat.size);
            fs.createReadStream(filePath).pipe(res);
            return;
        } catch (error) {
            console.error('Local video proxy error:', error.message);
            return res.status(404).json({ error: 'File not found or expired' });
        }
    }

    try {
        const videoUrl = req.query.url;
        if (!videoUrl) return res.status(400).json({ error: 'Video URL required' });

        const response = await axios.get(videoUrl, {
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 30000
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        response.data.pipe(res);

    } catch (error) {
        console.error('Video proxy error:', error.message);
        res.status(500).json({ error: 'Failed to fetch video' });
    }
});

app.get('/api/stats', async (req, res) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [total, monthly, active] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ joinedAt: { $gte: startOfMonth } }),      // joined this month
        User.countDocuments({ lastActive: { $gte: thirtyDaysAgo } }),   // active last 30 days
    ]);

    res.json({ total, monthly, active });
});

// ─── Bot stats helper ────
async function getBotStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const [total, monthly] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ joinedAt: { $gte: startOfMonth } }),
    ]);
    return { total, monthly };
}

async function updateBotDescription() {
    try {
        const { total } = await getBotStats();
        await bot.telegram.setMyDescription(
            `⚡ Fast Free TikTok, Instagram, Facebook & YouTube Downloader with no limits and no ads\n\n ${total.toLocaleString()} total users`
        );
        console.log('Bot description updated');
    } catch (err) {
        console.error('Failed to update bot description:', err.message);
    }
}

// ─── Start server ─────
const server = app.listen(PORT, async () => {
    console.log(`Multi-Platform Downloader API running on port ${PORT}`);
    // console.log(`Frontend URL: ${frontendURL}`);

    await cleanupStaleTempFiles();
    setInterval(cleanupStaleTempFiles, YT_TEMP_MAX_AGE_MS);
    setInterval(pruneExpiredYouTubeQualitySelections, YT_QUALITY_SELECTION_TTL_MS);

    try {
        job.start();
        console.log('Cron job started');
    } catch (error) {
        console.error('Cron job failed to start:', error);
    }

    bot.launch()
        .then(() => console.log("Telegram bot started"))
        .catch((err) => console.error("Failed to start Telegram bot:", err));

    const shutdown = (signal) => {
        console.log(`Received ${signal}, shutting down gracefully...`);
        try {
            bot.stop(signal);
        } catch (e) { }
        server.close(() => {
            process.exit(0);
        });
        setTimeout(() => process.exit(0), 1500);
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    // Update description once on startup, then every 6 hours
    await updateBotDescription();
    setInterval(updateBotDescription, 6 * 60 * 60 * 1000);
});
