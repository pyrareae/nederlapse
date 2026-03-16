import express from "express";
import cron from "node-cron";
import { createReadStream, statSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrape } from "./scrape.js";
import { compile } from "./compile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const IMAGES_DIR = path.join(__dirname, "..", "images");
const PUBLIC_DIR = path.join(__dirname, "public");
const VIDEO_PATH = path.join(OUTPUT_DIR, "timelapse.mp4");
const PORT = process.env.PORT || 3000;

const app = express();

app.use(express.static(PUBLIC_DIR));

// Video endpoint with range request support for seeking
app.get("/video", (req, res) => {
  if (!existsSync(VIDEO_PATH)) {
    return res.status(404).json({ error: "Video not yet compiled. Run `npm run scrape` then `npm run compile`." });
  }

  const stat = statSync(VIDEO_PATH);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    });
    createReadStream(VIDEO_PATH, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": "video/mp4",
    });
    createReadStream(VIDEO_PATH).pipe(res);
  }
});

// Status endpoint
app.get("/status", (req, res) => {
  let imageCount = 0;
  let firstImage = null;
  let lastImage = null;

  try {
    const files = readdirSync(IMAGES_DIR).filter((f) => f.endsWith(".jpg")).sort();
    imageCount = files.length;
    if (files.length > 0) {
      firstImage = files[0].replace(".jpg", "");
      lastImage = files[files.length - 1].replace(".jpg", "");
    }
  } catch {}

  const videoExists = existsSync(VIDEO_PATH);
  let videoSize = 0;
  let videoModified = null;
  if (videoExists) {
    const stat = statSync(VIDEO_PATH);
    videoSize = stat.size;
    videoModified = stat.mtime.toISOString();
  }

  res.json({
    imageCount,
    firstImage,
    lastImage,
    videoExists,
    videoSize,
    videoModified,
  });
});

// Daily cron: scrape latest images and recompile at 20:00
cron.schedule("0 20 * * *", async () => {
  console.log(`[${new Date().toISOString()}] Cron: starting daily update...`);
  try {
    await scrape({ onlyLatest: true });
    await compile();
    console.log(`[${new Date().toISOString()}] Cron: daily update complete`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron: failed:`, err);
  }
});

app.listen(PORT, () => {
  console.log(`Nederlapse server running at http://localhost:${PORT}`);
  console.log("Daily auto-update scheduled at 20:00");
});
