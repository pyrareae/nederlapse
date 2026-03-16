# Nederlapse

Construction timelapse video generator for the [Utrecht Merwede](https://merwede.camera.bouwtimelapse.nl/) project. Scrapes all camera images, compiles them into a looping MP4, and serves it via a web UI with daily auto-updates.

## Prerequisites

- Node.js 20+
- ffmpeg
- Chromium (installed automatically by Playwright)

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
# Download all images (~14K across 105+ days)
npm run scrape

# Download only the last 3 days (for incremental updates)
npm run scrape -- --latest

# Compile downloaded images into output/timelapse.mp4
npm run compile

# Start the web server on http://localhost:3000
npm start
```

The server includes a daily cron job (20:00) that automatically scrapes new images and recompiles the video.

## How it works

1. **Scrape** — Playwright navigates the bouwtimelapse site date-by-date, intercepting Livewire responses to extract pre-signed S3 image URLs. Images are downloaded to `images/` with resume support (skips existing files).
2. **Compile** — ffmpeg concatenates all images chronologically into an H.264 MP4 at 30fps.
3. **Serve** — Express serves a minimal video player page with looping playback, speed controls, and a status endpoint (`GET /status`).
