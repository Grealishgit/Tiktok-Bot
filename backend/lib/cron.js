import cron from "cron";
import http from "http";
import https from "https";

function getHttpClient(urlString) {
    const parsedUrl = new URL(urlString);

    if (parsedUrl.protocol === "https:") return { client: https, parsedUrl };
    if (parsedUrl.protocol === "http:") return { client: http, parsedUrl };

    throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
}

const job = new cron.CronJob("*/14 * * * *", function () {
    const backendUrl = process.env.BACKEND_URL;

    if (!backendUrl) {
        console.error("[Cron] BACKEND_URL is not set");
        return;
    }

    try {
        const { client, parsedUrl } = getHttpClient(backendUrl);

        client
            .get(parsedUrl, (res) => {
                res.resume(); // Consume response body to free up memory
                if (res.statusCode === 200) console.log("GET request sent successfully");
                else console.log("GET request failed", res.statusCode);
            })
            .on("error", (e) => console.error("Error while sending request", e));
    } catch (error) {
        console.error("[Cron] invalid BACKEND_URL:", error.message);
    }


}, null, true); // Start the job immediately



export default job;

// CRON JOB EXPLANATION:
// Cron jobs are scheduled tasks that run periodically at fixed intervals
// we want to send 1 GET request for every 14 minutes
// How to define a "Schedule"?
//* */14 * * * * - Every 14 minutes//! MINUTE, HOUR, DAY OF THE MONTH, MONTH, DAY OF THE WEEK
//? EXAMPLES && EXPLANATION:
//* 14 **** - Every 14 minutes
//* 0 0 * * 0 - At midnight on every Sunday
//* 30 3 15 ✶✶ - At 3:30 AM, on the 15th of every month
//* 0 0 1 1 * - At midnight, on January 1st
//* 0 * * * * - Every hour