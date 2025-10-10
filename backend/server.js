import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import { Telegraf } from "telegraf";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// CORS configuration
app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:4000'],
    // Allow frontend dev server and production
    credentials: true
}));

app.get('/', (req, res) => {
    res.send('TikTok Downloader API is running');
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 🔑 Replace with your bot token from BotFather
const bot = new Telegraf(process.env.TOKEN);
// console.log(TOKEN);

// Start command
bot.start((ctx) => {
    console.log('Start command received');
    ctx.reply("👋 Hey! Send me a TikTok link and I'll download the video or carousel for you.");
});

// Handle TikTok links
bot.on("text", async (ctx) => {
    const url = ctx.message.text;

    // Check if it's TikTok
    if (!url.includes("tiktok.com")) {
        return ctx.reply("❌ Please send a valid TikTok link.");
    }

    try {
        ctx.reply("⏳ Downloading...");

        // Call local API
        const apiResponse = await axios.post('http://localhost:4000/api/download', { url });

        const result = apiResponse.data;

        if (result.type === 'carousel') {
            // Send images as media group (max 10 per group)
            const images = result.images;
            const maxPerGroup = 10;

            for (let i = 0; i < images.length; i += maxPerGroup) {
                const chunk = images.slice(i, i + maxPerGroup);
                const media = chunk.map((imageUrl, index) => ({
                    type: 'photo',
                    media: imageUrl,
                    caption: (i === 0 && index === 0) ? `✅ Here’s your TikTok carousel!\n${result.title}\n Made By Hunter😂😂` : undefined
                }));

                try {
                    await ctx.replyWithMediaGroup(media);
                    // Small delay between groups to avoid rate limits
                    if (i + maxPerGroup < images.length) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } catch (error) {
                    console.error('Error sending media group:', error);
                    // If media group fails, try sending individually
                    for (const imageUrl of chunk) {
                        try {
                            await ctx.replyWithPhoto(imageUrl);
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch (photoError) {
                            console.error('Error sending individual photo:', photoError);
                        }
                    }
                }
            }
        } else if (result.type === 'video') {
            // Send video
            await ctx.replyWithVideo({ url: result.video },
                { caption: `✅ Here’s your TikTok video!\n${result.title}\nMade By HunterDev😂😂!` });
        } else {
            ctx.reply("⚠️ Unknown media type.");
        }

    } catch (err) {
        console.error(err);
        ctx.reply("❌ Error fetching the TikTok. Try again later or get the fuck out.");
    }
});

bot.launch();




async function resolveTikTokUrl(url) {
    try {
        const response = await axios.get(url, {
            maxRedirects: 0,
            validateStatus: (status) => status === 301 || status === 302
        });

        const finalUrl = response.headers.location;
        return finalUrl || url;
    } catch (error) {
        console.error('Failed to resolve TikTok URL:', error.message);
        return url;
    }
}

// API endpoint to download TikTok videos
app.post('/api/download/video', async (req, res) => {
    try {
        const url = req.body?.url;

        if (!url || !url.includes('tiktok.com')) {
            return res.status(400).json({ error: 'Please provide a valid TikTok URL' });
        }

        const apiUrl = `https://tikwm.com/api?url=${encodeURIComponent(url)}`;
        const { data } = await axios.get(apiUrl);

        if (data.code !== 0 || !data.data || !data.data.play) {
            return res.status(404).json({ error: 'Could not fetch the video. Maybe it\'s private or not a video?' });
        }

        res.json({
            video: data.data.play,
            title: data.data.title || 'TikTok Video'
        });

        console.log(data);

    } catch (error) {
        console.error('Video download error:', error);
        res.status(500).json({ error: 'Server error while downloading video' });
    }
});

// API endpoint to download TikTok carousels
app.post('/api/download/carousel', async (req, res) => {
    try {
        const url = req.body?.url;


        if (!url || !url.includes('tiktok.com')) {
            return res.status(400).json({ error: 'Please provide a valid TikTok URL' });
        }

        const apiUrl = `https://tikwm.com/api?url=${encodeURIComponent(url)}`;
        const { data } = await axios.get(apiUrl);

        if (data.code !== 0 || !data.data || !data.data.images || data.data.images.length === 0) {
            return res.status(404).json({ error: 'Could not fetch the carousel. Maybe it\'s private or not a carousel?' });
        }

        res.json({
            images: data.data.images,
            title: data.data.title || 'TikTok Carousel'
        });

    } catch (error) {
        console.error('Carousel download error:', error);
        res.status(500).json({ error: 'Server error while downloading carousel' });
    }
});

// General download endpoint (detects type)
app.post('/api/download', async (req, res) => {
    try {
        let url = req.body?.url;

        if (!url) {
            return res.status(400).json({ error: 'Please provide a TikTok URL' });
        }

        // 🔹 Resolve short links (vm.tiktok.com, vt.tiktok.com, etc.)
        if (url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) {
            try {
                const response = await axios.get(url, {
                    maxRedirects: 0,
                    validateStatus: status => status === 301 || status === 302
                });

                if (response.headers.location) {
                    url = response.headers.location;
                }
            } catch (err) {
                console.error("Short link resolution failed:", err.message);
                return res.status(400).json({ error: 'Failed to resolve short TikTok URL' });
            }
        }

        // ✅ Now check again after resolving
        if (!url.includes('tiktok.com')) {
            return res.status(400).json({ error: 'Please provide a valid TikTok URL' });
        }

        // Call tikwm API
        const apiUrl = `https://tikwm.com/api?url=${encodeURIComponent(url)}`;
        const { data } = await axios.get(apiUrl);

        if (data.code !== 0 || !data.data) {
            return res.status(404).json({ error: 'Could not fetch TikTok (maybe private?)' });
        }

        if (data.data.images && data.data.images.length > 0) {
            return res.json({
                type: 'carousel',
                images: data.data.images,
                title: data.data.title || 'TikTok Carousel',
                id: data.data.id,
                region: data.data.region,
                author: data.data.author,
                digg_count: data.data.digg_count,
                comment_count: data.data.comment_count,
                download_count: data.data.download_count,
                original: data.data.original,
                origin_cover: data.data.origin_cover,
                share_count: data.data.share_count,
                play_count: data.data.play_count,
                duration: data.data.duration,
                create_time: data.data.create_time,
            });
        } else if (data.data.play) {
            return res.json({
                type: 'video',
                video: data.data.play,
                title: data.data.title || 'TikTok Video',
                id: data.data.id,
                region: data.data.region,
                author: data.data.author,
                digg_count: data.data.digg_count,
                comment_count: data.data.comment_count,
                download_count: data.data.download_count,
                original: data.data.original,
                origin_cover: data.data.origin_cover,
                share_count: data.data.share_count,
                play_count: data.data.play_count,
                duration: data.data.duration,
                create_time: data.data.create_time,
            });
        } else {
            return res.status(404).json({ error: 'No media found in this TikTok' });
        }

    } catch (error) {
        console.error('Download error:', error.message);
        res.status(500).json({ error: 'Server error while downloading' });
    }
});

// Proxy images to bypass CORS/network issues
app.get('/api/image', async (req, res) => {
    try {
        const imageUrl = req.query.url;
        if (!imageUrl) {
            return res.status(400).json({ error: 'Image URL required' });
        }

        // Fetch the image from TikTok CDN
        const response = await axios.get(imageUrl, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Set appropriate headers
        res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

        // Pipe the image stream to response
        response.data.pipe(res);

    } catch (error) {
        console.error('Image proxy error:', error.message);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

app.listen(PORT, () => {
    console.log(`TikTok Downloader API running on port ${PORT}`);
});