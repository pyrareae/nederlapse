import { execFile } from "node:child_process";
import { readdir, mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, "..", "images");
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "timelapse.mp4");
const CONCAT_FILE = path.join(OUTPUT_DIR, "concat.txt");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${err.message}\n${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line.startsWith("frame=")) {
        process.stdout.write(`\r  ${line}`);
      }
    });
  });
}

export async function compile() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const files = (await readdir(IMAGES_DIR))
    .filter((f) => f.endsWith(".jpg"))
    .sort();

  if (files.length === 0) {
    console.error("No images found in images/. Run `npm run scrape` first.");
    process.exit(1);
  }

  console.log(`Compiling ${files.length} images into video...`);

  // Write ffmpeg concat file
  const concatContent = files
    .map((f) => `file '${path.join(IMAGES_DIR, f)}'`)
    .join("\n");
  await writeFile(CONCAT_FILE, concatContent);

  // Compile video: 30fps, H.264, decent quality
  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", CONCAT_FILE,
    "-framerate", "30",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    OUTPUT_FILE,
  ];

  await runFfmpeg(args);
  console.log(`\nVideo saved to ${OUTPUT_FILE}`);

  // Cleanup concat file
  await unlink(CONCAT_FILE).catch(() => {});

  const dateRange = {
    first: files[0].replace(".jpg", "").replace(/_/g, " ").replace(/-/g, (m, offset) => offset <= 7 ? "-" : ":"),
    last: files[files.length - 1].replace(".jpg", "").replace(/_/g, " ").replace(/-/g, (m, offset) => offset <= 7 ? "-" : ":"),
    count: files.length,
  };
  console.log(`Date range: ${dateRange.first} to ${dateRange.last}`);
  return dateRange;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  compile().catch((err) => {
    console.error("Compilation failed:", err);
    process.exit(1);
  });
}
