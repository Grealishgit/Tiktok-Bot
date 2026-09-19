import { Telegraf } from "telegraf";
import express from "express";

import axios from "axios";

import dotenv from "dotenv";
const PORT = process.env.PORT || 4005

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
    upsertUserBasic(ctx.from.id, ctx.from.username);
    const user = getUser(ctx.from.id);
    const name = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "there";
    // const name = ctx.from.first_name || ctx.from.username || "there";

    console.log('Start command received');
    ctx.reply(`👋 Hey!  ${name}! Send me a TikTok link and I'll download the video or carousel for you.`);
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
        const apiResponse = await axios.post('http://localhost:4005/api/download', { url });

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
        ctx.reply("Error fetching the TikTok. Try again later or get the fuck out.");
    }
});

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