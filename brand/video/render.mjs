// Renders a promo video frame by frame into an MP4 (H.264, 1920x1080, 30 fps), or a few stills to check a cut.
// "tour" is tour.html, "live" is live.html, "burn" is burn.html, "bot" is bot.html, "review" is ad.html?v=review, demo-intro/demo-outro are demo.html; music-<video>.wav, when present, is muxed in (AAC,
// loudness-normalized to -14 LUFS). Run from apps/web, where Playwright is installed:
//   cp ../../brand/video/render.mjs .render.mjs && node .render.mjs tour ../../brand/video/moatpad-tour.mp4; rm .render.mjs
//   node .render.mjs live ../../brand/video/moatpad-live.mp4
//   node .render.mjs tour --stills 1,6,14     # PNGs next to the HTML, for a quick look
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [video = "review", out = `moatpad-${video}.mp4`, flag, list] = process.argv.slice(2);
const page = await (await chromium.launch()).newPage({ viewport: { width: 1920, height: 1080 } });
// demo-intro / demo-outro are the two ends of the launch demo (demo.html?part=…, see build-demo.sh)
const html = video.startsWith("demo-") ? "demo.html" : ({ tour: "tour.html", live: "live.html", burn: "burn.html", bot: "bot.html" }[video] ?? "ad.html");
await page.goto(`${pathToFileURL(resolve(`../../brand/video/${html}`)).href}?v=${video}&part=${video.replace(/^demo-/, "")}`);
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => window.DURATION);
// a page may ask for its own frame rate, and list the moments its soundtrack should mark (music.py reads sfx-<video>.json)
const FPS = (await page.evaluate(() => window.FPS)) || 30;
const sfx = await page.evaluate(() => window.SFX ?? null);
if (sfx) writeFileSync(resolve(`../../brand/video/sfx-${video}.json`), JSON.stringify(sfx));

if (out === "--stills" || flag === "--stills") {
  for (const s of (list ?? flag).split(",").map(Number)) {
    await page.evaluate((t) => window.render(t), s);
    await page.screenshot({ path: resolve(`../../brand/video/still-${video}-${s}.png`) });
  }
  process.exit(0);
}

// live.html has film grain, which costs bits without adding detail: a higher CRF keeps it near 20 MB.
const CRF = video === "live" ? "25" : video === "bot" ? "19" : "17";
const music = resolve(`../../brand/video/music-${video}.wav`);
const audio = existsSync(music) ? ["-i", music, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest"] : [];
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", ...audio,
  "-c:v", "libx264", "-preset", "slow", "-crf", CRF, "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(out)], { stdio: ["pipe", "inherit", "inherit"] });
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
