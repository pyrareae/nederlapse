import { chromium } from "playwright";
import { writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, "..", "images");
const SITE_URL = "https://merwede.camera.bouwtimelapse.nl/";

function parseAvailableDates(html) {
  const dates = new Set();
  const enableStart = html.indexOf("enable:");
  if (enableStart === -1) return [];
  let depth = 0;
  let blockStart = -1;
  let blockEnd = -1;
  for (let i = enableStart; i < html.length; i++) {
    if (html[i] === "[") {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (html[i] === "]") {
      depth--;
      if (depth === 0) {
        blockEnd = i;
        break;
      }
    }
  }
  if (blockStart > -1 && blockEnd > -1) {
    const block = html.slice(blockStart, blockEnd + 1);
    for (const m of block.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)) {
      dates.add(m[1]);
    }
  }
  return [...dates].sort();
}

function extractImagesFromSnapshot(snapshot) {
  const data = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
  const imageGroups = data.data?.images?.[0];
  if (!imageGroups) return [];
  const images = [];
  for (const group of imageGroups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (item && typeof item === "object" && item.zoom_url && item.datetime) {
        images.push({
          datetime: item.datetime,
          url: item.zoom_url,
          filename:
            item.datetime.replace(/ /g, "_").replace(/:/g, "-") + ".jpg",
        });
      }
    }
  }
  return images.sort((a, b) => a.datetime.localeCompare(b.datetime));
}

function extractImagesFromInitialHtml(html) {
  const match = html.match(/wire:snapshot="([^"]+)"/);
  if (!match) return [];
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'");
  return extractImagesFromSnapshot(JSON.parse(decoded));
}

async function downloadImage(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filepath, buf);
}

async function downloadBatch(images, concurrency = 15) {
  let downloaded = 0;
  let skipped = 0;
  const queue = [...images];

  async function worker() {
    while (queue.length > 0) {
      const img = queue.shift();
      const filepath = path.join(IMAGES_DIR, img.filename);
      if (existsSync(filepath)) {
        skipped++;
        continue;
      }
      try {
        await downloadImage(img.url, filepath);
        downloaded++;
      } catch (err) {
        console.error(`  Failed: ${img.filename}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { downloaded, skipped };
}

export async function scrape({ onlyLatest = false } = {}) {
  await mkdir(IMAGES_DIR, { recursive: true });

  const existingFiles = new Set();
  try {
    for (const f of await readdir(IMAGES_DIR)) {
      if (f.endsWith(".jpg")) existingFiles.add(f);
    }
  } catch {}

  console.log(
    `Starting scraper (${existingFiles.size} images already on disk)`
  );

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Capture Livewire update responses
  let pendingImages = null;
  page.on("response", async (response) => {
    if (!response.url().includes("livewire/update")) return;
    try {
      const json = await response.json();
      // Find the component that has images
      for (const comp of json.components || []) {
        if (!comp.snapshot) continue;
        const imgs = extractImagesFromSnapshot(comp.snapshot);
        if (imgs.length > 0) {
          pendingImages = imgs;
        }
      }
    } catch {}
  });

  try {
    console.log("Loading page...");
    await page.goto(SITE_URL, { waitUntil: "networkidle" });

    const html = await page.content();
    const availableDates = parseAvailableDates(html);
    console.log(
      `Found ${availableDates.length} dates (${availableDates[0]} to ${availableDates[availableDates.length - 1]})`
    );

    // Get current date from the initial page load
    const initialMatch = html.match(/defaultDate:\s*'(\d{4}-\d{2}-\d{2})'/);
    const currentDate = initialMatch?.[1];

    const datesToScrape = onlyLatest
      ? availableDates.slice(-3)
      : availableDates;

    for (let i = 0; i < datesToScrape.length; i++) {
      const date = datesToScrape[i];
      const progress = `[${i + 1}/${datesToScrape.length}]`;

      // Check if we already have images for this date
      const existing = [...existingFiles].filter((f) =>
        f.startsWith(date)
      );
      if (existing.length > 20 && !onlyLatest) {
        console.log(
          `${progress} ${date}: ${existing.length} images exist, skipping`
        );
        continue;
      }

      let images;

      if (date === currentDate && i === datesToScrape.length - 1) {
        // Use initial page HTML for current date (no navigation needed)
        images = extractImagesFromInitialHtml(html);
      } else {
        // Navigate to date via Livewire dispatch
        pendingImages = null;
        await page.evaluate(
          (d) => window.Livewire.dispatch("dateChanged", { date: d }),
          date
        );

        // Wait for the Livewire response with image data
        const deadline = Date.now() + 10000;
        while (!pendingImages && Date.now() < deadline) {
          await page.waitForTimeout(300);
        }

        images = pendingImages || [];
        pendingImages = null;
      }

      if (images.length === 0) {
        console.log(`${progress} ${date}: No images found`);
        continue;
      }

      console.log(
        `${progress} ${date}: ${images.length} images, downloading...`
      );
      const { downloaded, skipped } = await downloadBatch(images);
      console.log(`  -> ${downloaded} new, ${skipped} skipped`);

      for (const img of images) {
        existingFiles.add(img.filename);
      }
    }

    console.log(`Done! Total images on disk: ${existingFiles.size}`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const onlyLatest = process.argv.includes("--latest");
  scrape({ onlyLatest }).catch((err) => {
    console.error("Scraper failed:", err);
    process.exit(1);
  });
}
