// PNG exports of brand/*.svg plus the X banner. Playwright lives in apps/web, so run it from there:
//   cd apps/web && cp ../../brand/export.mjs .brand-export.mjs && node .brand-export.mjs; rm .brand-export.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const BRAND = resolve(process.cwd(), "../../brand");
const FONTS = resolve(process.cwd(), "node_modules/geist/dist/fonts/geist-sans");
const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString("base64")}`;
const svgUrl = (name) => dataUrl(`${BRAND}/${name}`, "image/svg+xml");

mkdirSync(`${BRAND}/png`, { recursive: true });
const browser = await chromium.launch();

async function shoot(html, out, width, height, transparent) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${BRAND}/png/${out}`, omitBackground: transparent });
  await page.close();
}

async function png(svg, out, width, height, background = "transparent") {
  const html = `<body style="margin:0;background:${background}"><img src="${svgUrl(svg)}" style="width:${width}px;height:${height}px;display:block"></body>`;
  await shoot(html, out, width, height, background === "transparent");
}

await png("holdfast-mark.svg", "holdfast-mark-1024.png", 1024, 1024);
await png("holdfast-mark.svg", "holdfast-mark-512.png", 512, 512);
await png("holdfast-mark.svg", "apple-touch-icon-180.png", 180, 180);
await png("holdfast-avatar.svg", "holdfast-avatar-1000.png", 1000, 1000);
await png("holdfast-avatar.svg", "holdfast-avatar-400.png", 400, 400);
await png("holdfast-glyph-mint.svg", "holdfast-glyph-mint-512.png", Math.round((512 * 42) / 53), 512);
await png("holdfast-logo.svg", "holdfast-logo-on-dark.png", 1000, 256, "#07080c");
await png("holdfast-logo.svg", "holdfast-logo-transparent.png", 1000, 256);
await png("holdfast-logo-on-light.svg", "holdfast-logo-on-light.png", 1000, 256, "#ffffff");

// X / Twitter header (1500×500). Content stays centred: the profile picture covers the bottom left.
const banner = `<!doctype html><html><head><style>
@font-face{font-family:G;src:url(${dataUrl(`${FONTS}/Geist-SemiBold.ttf`, "font/ttf")})}
@font-face{font-family:GR;src:url(${dataUrl(`${FONTS}/Geist-Regular.ttf`, "font/ttf")})}
body{margin:0;width:1500px;height:500px;background:radial-gradient(900px 420px at 50% 120%,rgba(126,240,184,.16),transparent 70%),#07080c;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px}
h1{font:600 58px G;color:#eceef4;margin:0;letter-spacing:-1.2px}
p{font:400 25px GR;color:#949bad;margin:0} b{color:#7ef0b8;font-weight:400}
</style></head><body>
<img src="${svgUrl("holdfast-logo.svg")}" height="84">
<h1>Memecoins that defend their floor</h1>
<p><b>60%</b> floor vault &nbsp;·&nbsp; <b>30%</b> paid to holders every 2 min &nbsp;·&nbsp; <b>10%</b> $HOLD burn &nbsp;·&nbsp; <b>0%</b> dev</p>
</body></html>`;
await shoot(banner, "holdfast-x-banner-1500x500.png", 1500, 500, false);

await browser.close();
console.log(`wrote ${BRAND}/png`);
