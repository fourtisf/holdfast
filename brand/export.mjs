// PNG exports of brand/*.svg, the X header and the brand board. Playwright lives in apps/web:
//   cd apps/web && cp ../../brand/export.mjs .brand-export.mjs && node .brand-export.mjs; rm .brand-export.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const BRAND = resolve(process.cwd(), "../../brand");
const FONTS = resolve(process.cwd(), "node_modules/geist/dist/fonts/geist-sans");
const OUT = `${BRAND}/png`;
const b64 = (file) => readFileSync(file).toString("base64");
const svgUrl = (name) => `data:image/svg+xml;base64,${b64(`${BRAND}/${name}`)}`;
const ratio = (name) => {
  const [, , w, h] = /viewBox="([^"]+)"/.exec(readFileSync(`${BRAND}/${name}`, "utf8"))[1].split(/\s+/).map(Number);
  return w / h;
};
const fonts = `@font-face{font-family:GS;src:url(data:font/ttf;base64,${b64(`${FONTS}/Geist-SemiBold.ttf`)})}
@font-face{font-family:GM;src:url(data:font/ttf;base64,${b64(`${FONTS}/Geist-Medium.ttf`)})}
@font-face{font-family:GR;src:url(data:font/ttf;base64,${b64(`${FONTS}/Geist-Regular.ttf`)})}`;

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(`${OUT}/${f}`);
const browser = await chromium.launch();

async function shoot(html, out, width, height, transparent = false) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${out}`, omitBackground: transparent });
  await page.close();
}

/** One SVG at a fixed height (width from its viewBox), centred on `background` with `pad` px around it. */
async function png(svg, out, height, { background = "transparent", pad = 0 } = {}) {
  const w = Math.round(height * ratio(svg));
  const html = `<body style="margin:0;background:${background};padding:${pad}px"><img src="${svgUrl(svg)}" style="width:${w}px;height:${height}px;display:block"></body>`;
  await shoot(html, out, w + 2 * pad, height + 2 * pad, background === "transparent");
}

await png("holdfast-icon.svg", "holdfast-icon-1024.png", 1024);
await png("holdfast-icon.svg", "holdfast-icon-512.png", 512);
await png("holdfast-icon.svg", "apple-touch-icon-180.png", 180);
await png("holdfast-avatar.svg", "holdfast-avatar-1000.png", 1000);
await png("holdfast-avatar.svg", "holdfast-avatar-400.png", 400);
await png("holdfast-mark.svg", "holdfast-mark-1024.png", 1024);
await png("holdfast-mark-on-light.svg", "holdfast-mark-on-light-1024.png", 1024);
await png("holdfast-logo.svg", "holdfast-logo-transparent.png", 240);
await png("holdfast-logo.svg", "holdfast-logo-on-dark.png", 240, { background: "#07080c", pad: 120 });
await png("holdfast-logo-on-light.svg", "holdfast-logo-on-light.png", 240, { background: "#ffffff", pad: 120 });
await png("holdfast-logo-stacked.svg", "holdfast-logo-stacked-on-dark.png", 640, { background: "#07080c", pad: 180 });

const page = (body, css = "") => `<!doctype html><html><head><style>${fonts}
body{margin:0;background:#07080c;color:#eef2ef;font-family:GR} ${css}</style></head><body>${body}</body></html>`;

// X / Twitter header 1500×500: content centred (the profile picture covers the bottom left).
await shoot(
  page(
    `<img class="wm" src="${svgUrl("holdfast-mark.svg")}">
     <img src="${svgUrl("holdfast-logo.svg")}" style="height:86px">
     <h1>Memecoins that defend their floor</h1>
     <p><b>60%</b> floor vault <i>·</i> <b>30%</b> paid to holders every 2 min <i>·</i> <b>10%</b> $HOLD burn <i>·</i> <b>0%</b> dev</p>`,
    `body{width:1500px;height:500px;overflow:hidden;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;
      background:radial-gradient(700px 360px at 50% -10%,rgba(95,232,168,.18),transparent 70%),radial-gradient(900px 300px at 50% 120%,rgba(12,134,83,.22),transparent 70%),#07080c}
     .wm{position:absolute;right:-60px;top:-40px;height:620px;opacity:.06}
     h1{font:500 50px GM;letter-spacing:-.5px;margin:6px 0 0} p{font:400 23px GR;color:#949bad;margin:0;letter-spacing:.2px} b{color:#7ef0b8;font-weight:400} i{color:#3a4150;font-style:normal;margin:0 8px}`,
  ),
  "holdfast-x-banner-1500x500.png",
  1500,
  500,
);

// Brand board: everything on one page, for sharing.
const swatch = (hex, name) => `<div class="sw"><div style="background:${hex}"></div><span>${name}</span><code>${hex}</code></div>`;
await shoot(
  page(
    `<header><img src="${svgUrl("holdfast-logo.svg")}" style="height:40px"><span>Brand mark · v2</span></header>
     <main>
       <section class="hero"><img src="${svgUrl("holdfast-icon.svg")}" style="width:360px;height:360px"></section>
       <section class="col">
         <div class="card dark"><img src="${svgUrl("holdfast-logo.svg")}" style="height:84px"></div>
         <div class="card light"><img src="${svgUrl("holdfast-logo-on-light.svg")}" style="height:84px"></div>
         <div class="row">
           <div class="card dark small"><img src="${svgUrl("holdfast-avatar.svg")}" style="height:120px;border-radius:50%"></div>
           <div class="card light small"><img src="${svgUrl("holdfast-mark-black.svg")}" style="height:96px"></div>
           <div class="card dark small sizes"><img src="${svgUrl("holdfast-icon.svg")}" style="height:64px"><img src="${svgUrl("holdfast-icon.svg")}" style="height:40px"><img src="${svgUrl("holdfast-favicon.svg")}" style="height:24px"><img src="${svgUrl("holdfast-favicon.svg")}" style="height:16px"></div>
         </div>
       </section>
     </main>
     <footer>
       <p><b>The mark:</b> a monogram H built like a rampart. Two walls hold; between them a chevron rises. Every coin's vault defends its floor while the price climbs.</p>
       <div class="sws">${swatch("#5fe8a8", "Emerald")}${swatch("#d4ffe9", "Mint light")}${swatch("#0c8653", "Deep emerald")}${swatch("#07080c", "Night")}${swatch("#eef2ef", "Paper")}</div>
     </footer>`,
    `body{width:1600px;height:1000px;padding:56px 64px;box-sizing:border-box;display:flex;flex-direction:column;gap:36px;
      background:radial-gradient(800px 500px at 18% 45%,rgba(95,232,168,.10),transparent 70%),#07080c}
     header{display:flex;align-items:center;justify-content:space-between} header span{font:500 15px GM;color:#6b7385;letter-spacing:.18em;text-transform:uppercase}
     main{display:flex;gap:40px;flex:1} .hero{width:520px;display:flex;align-items:center;justify-content:center;border:1px solid #1a1e26;border-radius:28px;background:#0b0d12}
     .col{flex:1;display:flex;flex-direction:column;gap:20px} .row{display:flex;gap:20px;flex:1}
     .card{border-radius:22px;display:flex;align-items:center;justify-content:center;padding:34px;flex:1}
     .dark{background:#0b0d12;border:1px solid #1a1e26} .light{background:#f4f6f5} .small{padding:20px} .sizes{gap:22px}
     footer{display:flex;align-items:center;justify-content:space-between;gap:40px}
     footer p{font:400 17px/1.55 GR;color:#949bad;max-width:560px;margin:0} footer b{color:#eef2ef;font-weight:400}
     .sws{display:flex;gap:16px} .sw{display:flex;flex-direction:column;gap:6px;font:500 12px GM;color:#949bad}
     .sw div{width:92px;height:56px;border-radius:12px;border:1px solid #232733} .sw code{font:400 12px GR;color:#6b7385}`,
  ),
  "holdfast-brand-board.png",
  1600,
  1000,
);

await browser.close();
console.log(`wrote ${readdirSync(OUT).length} files to ${OUT}`);
