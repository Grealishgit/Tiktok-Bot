import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import { Telegraf } from "telegraf";
import job from './lib/cron.js';
import youtubeDl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT;
const frontendURL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.BACKEND_URL;

// CORS configuration
app.use(cors({
    origin: ['https://tiktok-bot-downloader.vercel.app',
        'https://tiktok-bot-zgte.onrender.com', 'https://www.hunterdev.live', 'http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('Multi-Platform Downloader API is running');
});

// ─── Platform detection ───────────────────────────────────────────────────────
function detectPlatform(url) {
    if (url.includes('tiktok.com') || url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com') || url.includes('instagr.am')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) return 'facebook';
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    return null;
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
        return { ...base, type: 'video', video: d.play };
    }

    throw new Error('No media found in this TikTok');
}

// ─── Instagram / Facebook downloader (yt-dlp) ────────────────────────────────
async function downloadWithYtDlp(url) {
    try {
        // First, get info without downloading
        const info = await youtubeDl(url, {
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
                return {
                    type: 'video',
                    video: videos[0],
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
        if (!videoUrl && info.formats) {
            // Pick best mp4 format with both video+audio
            const fmt = info.formats
                .filter(f => f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0]
                || info.formats[info.formats.length - 1];
            videoUrl = fmt?.url;
        }

        if (!videoUrl) throw new Error('No downloadable URL found');

        return {
            type: 'video',
            video: videoUrl,
            title: info.title || 'Video',
            author: info.uploader || info.channel || null,
            duration: info.duration || null,
        };

    } catch (err) {
        console.error('yt-dlp error:', err.message);
        throw new Error('Could not fetch media. The post may be private or unsupported.');
    }
}


async function downloadYouTube(url) {
    try {
        const info = await youtubeDl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificate: true,
            addHeader: ['referer:https://www.youtube.com', 'user-agent:Mozilla/5.0'],
            // Pull best mp4 under 50MB where possible
            format: 'bestvideo[ext=mp4][filesize<50M]+bestaudio[ext=m4a]/best[ext=mp4][filesize<50M]/best',
        });

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

        // Pick best mp4 format
        let videoUrl = info.url;
        if (!videoUrl && info.formats) {
            const fmt = info.formats
                .filter(f => f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none')
                .sort((a, b) => (b.height || 0) - (a.height || 0))[0]
                || info.formats[info.formats.length - 1];
            videoUrl = fmt?.url;
        }

        if (!videoUrl) throw new Error('No downloadable URL found');

        return {
            type: 'video',
            video: videoUrl,
            title: info.title || 'YouTube Video',
            author: info.uploader || info.channel || null,
            duration: info.duration || null,
            thumbnail: info.thumbnail || null,
            view_count: info.view_count || null,
            like_count: info.like_count || null,
            upload_date: info.upload_date || null,
        };

    } catch (err) {
        console.error('YouTube yt-dlp error:', err.message);
        throw new Error('Could not fetch YouTube video. It may be age-restricted or unavailable.');
    }
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
const bot = new Telegraf(process.env.TOKEN);

bot.start((ctx) => {
    ctx.reply(
        '👋 Welcome! Send me a link from:\n\n' +
        '🎵 TikTok\n📸 Instagram (reels, posts, carousels)\n📘 Facebook (reels, videos)\n▶️ YouTube (videos, shorts)\n\n' +
        'And I\'ll download it for you!'
    );
});

bot.on('text', async (ctx) => {
    const url = ctx.message.text.trim();
    const platform = detectPlatform(url);

    if (!platform) {
        return ctx.reply('Please send a valid TikTok, Instagram, or Facebook link.');
    }

    const platformEmoji = { tiktok: '🎵', instagram: '📸', facebook: '📘', youtube: '▶️' }[platform];
    await ctx.reply(`${platformEmoji} Fetching your ${platform} media, please wait...`);

    try {
        const result = await downloadMedia(url);

        if (result.type === 'carousel') {
            const images = result.images;
            const maxPerGroup = 10;

            for (let i = 0; i < images.length; i += maxPerGroup) {
                const chunk = images.slice(i, i + maxPerGroup);
                const media = chunk.map((imageUrl, index) => ({
                    type: 'photo',
                    media: imageUrl,
                    caption: (i === 0 && index === 0)
                        ? `📸 ${result.title}\n\nMade by HunterDev`
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

        } else if (result.type === 'video') {
            try {
                await ctx.replyWithVideo(
                    { url: result.video },
                    { caption: `🎬 ${result.title}\n\nMade by HunterDev` }
                );
            } catch (videoErr) {
                // Telegram has a 50MB bot upload limit — fall back to link
                console.error('Video send failed (likely too large):', videoErr.message);
                await ctx.reply(
                    `⚠️ The video is too large for Telegram to send directly.\n\n` +
                    `🔗 Direct link (tap & hold to save):\n${result.video}`
                );
            }
        } else if (result.type === 'playlist') {
            // Telegram can't bulk-send a playlist, so send a summary with links
            const lines = result.entries.slice(0, 20).map((e, i) =>
                `${i + 1}. ${e.title} — ${e.url}`
            );
            const truncated = result.entries.length > 20
                ? `\n\n...and ${result.entries.length - 20} more.` : '';

            await ctx.reply(
                `▶️ Playlist: ${result.title} (${result.count} videos)\n\n` +
                lines.join('\n') + truncated
            );
        }

    } catch (err) {
        console.error('Bot error:', err.message);
        ctx.reply(`${err.message}`);
    }
});

// ─── API Routes ───────────────────────────────────────────────────────────────

// General download endpoint — all platforms
app.post('/api/download', async (req, res) => {
    try {
        const url = req.body?.url;
        if (!url) return res.status(400).json({ error: 'Please provide a URL' });

        const platform = detectPlatform(url);
        if (!platform) return res.status(400).json({ error: 'Unsupported platform' });

        const result = await downloadMedia(url);
        res.json({ platform, ...result });

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
            return res.status(400).json({ error: 'Please provide a valid TikTok URL' });
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

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Multi-Platform Downloader API running on port ${PORT}`);
    console.log(`Frontend URL: ${frontendURL}`);

    try {
        job.start();
        console.log('Cron job started');
    } catch (error) {
        console.error('Cron job failed to start:', error);
    }

    bot.launch();
    console.log('Telegram bot started');
});