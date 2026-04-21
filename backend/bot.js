import { Telegraf } from "telegraf"; import express from "express";

import axios from "axios";

import dotenv from "dotenv"; const PORT = 4000

const app = express();    

dotenv.config();

const { TOKEN } = process.env;

app.get('/', (req, res) => {
    res.send('TikTok Downloader Bot is running');
});

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
        return ctx.reply("Please send a valid TikTok link.");
    }

    try {
        ctx.reply("Downloading...");

        // Call local API
        const apiResponse = await axios.post('http://localhost:4000/api/download', { url });

        const result = apiResponse.data;

        if (result.type === 'carousel') {
            // Send images as media group
            const media = result.images.map((imageUrl, index) => ({
                type: 'photo',
                media: imageUrl,
                caption: index === 0 ? `Here’s your TikTok carousel! Made By Hunter\n${result.title}` : undefined
            }));
            await ctx.replyWithMediaGroup(media);
        } else if (result.type === 'video') {
            // Send video
            await ctx.replyWithVideo({ url: result.video },
                { caption: `Here’s your TikTok video! Made By Hunter\n${result.title}` });
        } else {
            ctx.reply("⚠️ Unknown media type.");
        }

    } catch (err) {
        console.error(err);
        ctx.reply("❌ Error fetching the TikTok. Try again later or get the fuck out.");
    }
});

bot.launch();