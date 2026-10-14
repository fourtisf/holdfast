// PNG exports, X header and brand board. Playwright lives in apps/web:
//   cd apps/web && cp ../../brand/export.mjs .brand-export.mjs && node .brand-export.mjs; rm .brand-export.mjs
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const BRAND = resolve(process.cwd(), "../../brand");
const OUT = `${BRAND}/png`;
const b64 = (f) => readFileSync(f).toString("base64");
const svg = (name) => `data:image/svg+xml;base64,${b64(`${BRAND}/${name}`)}`;
const render = (name) => `data:image/png;base64,${b64(`${BRAND}/3d/renders/${name}`)}`;
const font = `@font-face{font-family:Cin;src:url(data:font/woff;base64,${b64(`${BRAND}/fonts/Cinzel-SemiBold.woff`)})}
@font-face{font-family:GR;src:url(data:font/ttf;base64,${b64(resolve(process.cwd(), "node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf"))})}
@font-face{font-family:GL;src:url(data:font/ttf;base64,${b64(resolve(process.cwd(), "node_modules/geist/dist/fonts/geist-sans/Geist-Light.ttf"))})}`;

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(`${OUT}/${f}`);
const browser = await chromium.launch();
async function shoot(html, out, w, h, transparent = false) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<!doctype html><html><head><style>${font} body{margin:0}</style></head><body>${html}</body></html>`);
  await p.waitForTimeout(350);
  await p.screenshot({ path: `${OUT}/${out}`, omitBackground: transparent });
  await p.close();
}
const ratio = (name) => {
  const [, , w, h] = /viewBox="([^"]+)"/.exec(readFileSync(`${BRAND}/${name}`, "utf8"))[1].split(/\s+/).map(Number);
  return w / h;
};
const flat = (name, out, h, bg = "transparent", pad = 0) => {
  const w = Math.round(h * ratio(name));
  return shoot(`<div style="background:${bg};padding:${pad}px;width:${w}px"><img src="${svg(name)}" style="width:${w}px;height:${h}px;display:block"></div>`, out, w + 2 * pad, h + 2 * pad, bg === "transparent");
};
const TILE = "background:radial-gradient(circle at 50% 38%,#24262c,#08090b 72%)";
const icon = (size, out, radius) =>
  shoot(`<div style="width:${size}px;height:${size}px;${TILE};border-radius:${radius}px;display:flex;align-items:center;justify-content:center">
    <img src="${render("token-obsidian-gold.png")}" style="width:${size * 1.04}px"></div>`, out, size, size, radius > 0);

await icon(1024, "moatpad-icon-1024.png", 230);
await icon(512, "moatpad-icon-512.png", 115);
await icon(180, "apple-touch-icon-180.png", 0);
await icon(1000, "moatpad-avatar-1000.png", 0);
await icon(400, "moatpad-avatar-400.png", 0);
await flat("moatpad-mark.svg", "moatpad-mark-1024.png", 1024);
await flat("moatpad-logo.svg", "moatpad-logo-transparent.png", 240);
await flat("moatpad-logo.svg", "moatpad-logo-on-dark.png", 240, "#0a0b0e", 120);
await flat("moatpad-logo-on-light.svg", "moatpad-logo-on-light.png", 240, "#f4f2ec", 120);
await flat("moatpad-logo-stacked.svg", "moatpad-logo-stacked-on-dark.png", 560, "#0a0b0e", 160);
copyFileSync(`${BRAND}/3d/renders/coin-obsidian-gold.png`, `${OUT}/moatpad-coin-3d.png`);

const words = `font-family:Cin;letter-spacing:.2em;background:linear-gradient(180deg,#fbe8b4,#c99a3e);-webkit-background-clip:text;color:transparent`;
await shoot(`<div style="width:1500px;height:500px;display:flex;align-items:center;justify-content:center;gap:60px;overflow:hidden;
  background:radial-gradient(700px 420px at 30% 50%,rgba(233,191,98,.15),transparent 70%),linear-gradient(180deg,#0c0d10,#050608)">
  <img src="${render("coin-obsidian-gold.png")}" style="width:400px">
  <div><div style="${words};font-size:92px;line-height:1">MOATPAD</div>
  <div style="font:300 34px GL;color:#ece8de;margin:24px 0 14px">Every coin gets a moat.</div>
  <div style="font:300 20px GL;color:#8f95a2"><b style="color:#e9bf62;font-weight:300">60%</b> floor vault &nbsp;·&nbsp; <b style="color:#e9bf62;font-weight:300">30%</b> to holders every 2 min &nbsp;·&nbsp; <b style="color:#e9bf62;font-weight:300">10%</b> buyback &amp; burn &nbsp;·&nbsp; <b style="color:#e9bf62;font-weight:300">0%</b> dev</div></div></div>`,
  "moatpad-x-banner-1500x500.png", 1500, 500);

const sw = (hex, name) => `<div style="display:flex;flex-direction:column;gap:6px;font:400 12px GR;color:#8f95a2"><div style="width:92px;height:54px;border-radius:12px;background:${hex};border:1px solid #23252c"></div>${name}<span style="color:#5d6370">${hex}</span></div>`;
await shoot(`<div style="width:1600px;height:1000px;box-sizing:border-box;padding:56px 64px;display:flex;flex-direction:column;gap:30px;
  background:radial-gradient(800px 560px at 20% 52%,rgba(233,191,98,.12),transparent 70%),#08090c;color:#ece8de">
  <div style="display:flex;justify-content:space-between;align-items:center"><img src="${svg("moatpad-logo.svg")}" style="height:46px">
  <span style="font:400 14px GR;letter-spacing:.3em;color:#5d6370">BRAND · MOATPAD.FUN</span></div>
  <div style="display:flex;gap:28px;flex:1">
    <div style="width:560px;display:flex;align-items:center;justify-content:center"><img src="${render("coin-obsidian-gold.png")}" style="width:560px"></div>
    <div style="flex:1;display:flex;flex-direction:column;gap:22px">
      <div style="flex:1;border-radius:24px;background:#111216;border:1px solid #1e2027;display:flex;align-items:center;justify-content:center"><img src="${svg("moatpad-logo.svg")}" style="height:96px"></div>
      <div style="flex:1;border-radius:24px;background:#f4f2ec;display:flex;align-items:center;justify-content:center"><img src="${svg("moatpad-logo-on-light.svg")}" style="height:96px"></div>
      <div style="display:flex;gap:22px;flex:1">
        <div style="flex:1;border-radius:24px;background:#111216;border:1px solid #1e2027;display:flex;align-items:center;justify-content:center;gap:26px">
          <div style="width:132px;height:132px;border-radius:30px;${TILE};display:flex;align-items:center;justify-content:center"><img src="${render("token-obsidian-gold.png")}" style="width:136px"></div>
          <div style="width:132px;height:132px;border-radius:50%;${TILE};display:flex;align-items:center;justify-content:center;overflow:hidden"><img src="${render("token-obsidian-gold.png")}" style="width:136px"></div></div>
        <div style="flex:1;border-radius:24px;background:#111216;border:1px solid #1e2027;display:flex;align-items:center;justify-content:center;gap:24px">
          <img src="${svg("moatpad-favicon.svg")}" style="height:64px"><img src="${svg("moatpad-favicon.svg")}" style="height:40px"><img src="${svg("moatpad-favicon.svg")}" style="height:24px"><img src="${svg("moatpad-favicon.svg")}" style="height:16px"></div>
      </div></div></div>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:40px">
    <p style="font:300 18px/1.55 GL;color:#8f95a2;max-width:600px;margin:0"><b style="color:#ece8de;font-weight:400">Every coin gets a moat.</b> An obsidian coin bears a gold castle M; around it runs the moat, each coin's floor vault.</p>
    <div style="display:flex;gap:16px">${sw("#e8bc5b", "Gold")}${sw("#fff1c6", "Gold light")}${sw("#a97b2a", "Gold deep")}${sw("#0a0b0e", "Obsidian")}${sw("#f3efe4", "Ivory")}</div></div></div>`,
  "moatpad-brand-board.png", 1600, 1000);

await browser.close();
console.log(`wrote ${readdirSync(OUT).length} files`);
