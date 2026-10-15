// Renders ad.html frame by frame into an MP4 (H.264, 1920x1080, 30 fps), or a few stills to check a cut.
// Run from apps/web, where Playwright is installed:
//   cp ../../brand/video/render.mjs .render.mjs && node .render.mjs review ../../brand/video/moatpad-review.mp4; rm .render.mjs
//   node .render.mjs live out.mp4
//   node .render.mjs review --stills 1,6,14     # PNGs next to ad.html, for a quick look
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [video = "review", out = `moatpad-${video}.mp4`, flag, list] = process.argv.slice(2);
const FPS = 30;
const page = await (await chromium.launch()).newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${pathToFileURL(resolve("../../brand/video/ad.html")).href}?v=${video}`);
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => window.DURATION);

if (out === "--stills" || flag === "--stills") {
  for (const s of (list ?? flag).split(",").map(Number)) {
    await page.evaluate((t) => window.render(t), s);
    await page.screenshot({ path: resolve(`../../brand/video/still-${video}-${s}.png`) });
  }
  process.exit(0);
}

const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(out)], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.round(duration * FPS);
const started = Date.now();
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  const png = await page.screenshot({ type: "png" });
  if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 150 === 0) process.stdout.write(`frame ${i}/${frames} (${Math.round((Date.now() - started) / 1000)}s)\n`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`wrote ${out}: ${frames} frames, ${duration}s`);
process.exit(0);
