import { Telegraf } from "telegraf";
import axios from "axios";

import dotenv from "dotenv";

dotenv.config();
const { TOKEN } = process.env;

// 🔑 Replace with your bot token from BotFather
const bot = new Telegraf(process.env.TOKEN);
// console.log(TOKEN);


// Start command
bot.start((ctx) => {
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

        // ⚡ Example API (we can switch if you want)
        const apiUrl = `https://tikwm.com/api?url=${encodeURIComponent(url)}`;
        const { data } = await axios.get(apiUrl);

        if (data.code !== 0 || !data.data) {
            return ctx.reply("⚠️ Couldn't fetch the TikTok. Maybe it's private?");
        }

        // Check if it's a carousel (has images)
        if (data.data.images && data.data.images.length > 0) {
            // Send images as media group
            const media = data.data.images.map((imageUrl, index) => ({
                type: 'photo',
                media: imageUrl,
                caption: index === 0 ? "✅ Here’s your TikTok carousel! Made By Hunter😂😂" : undefined
            }));

            await ctx.replyWithMediaGroup(media);
        } else if (data.data.play) {
            // Send video
            await ctx.replyWithVideo({ url: data.data.play },
                { caption: "✅ Here’s your TikTok video!" },
                { caption: "Made By Hunter" }

            );
        } else {
            return ctx.reply("⚠️ No media found in this TikTok.");
        }

    } catch (err) {
        console.error(err);
        ctx.reply("❌ Error fetching the TikTok. Try again later or get the fuck out.");
    }
});

bot.launch();
