// Records the "launch a coin and watch it live" demo on the web app in mock mode (NEXT_PUBLIC_USE_MOCKS=1, :3311):
// a real walk through the create page with the demo wallet, the one-transaction launch confirmed in the wallet,
// and the new coin's page going live (a scripted price path; fees, floor, buybacks and payouts come from the
// simulated vault). The page clock is faked, so every frame is captured at an exact time; the camera is a clip
// of a 2x screenshot, and the overlay (cursor, callouts, captions, wallet prompt) is drawn into the page.
//   cd apps/web && cp ../../brand/video/capture-demo.mjs .demo.mjs && node .demo.mjs ../../brand/video/demo-app.mp4; rm .demo.mjs
//   node .demo.mjs --stills 3,9.5,22    # PNG stills (seconds into the capture) instead of a video
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.DEMO_BASE ?? "http://localhost:3311";
const FPS = 30;
const VIEW = { width: 1440, height: 810 };
const DPR = 2;
const args = process.argv.slice(2);
const stillsAt = args[0] === "--stills" ? args[1].split(",").map(Number) : null;
const out = resolve(stillsAt ? "." : (args[0] ?? "../../brand/video/demo-app.mp4"));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR })).newPage();
await page.clock.install({ time: new Date("2026-10-15T11:00:00Z") });
await page.goto(`${BASE}/create`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 200));

// ---- overlay (screen space: 1440 x 810, drawn over the camera's clip) ------------------------------------
await page.addStyleTag({
  content: `
  [data-sonner-toaster], nextjs-portal { display: none !important; }
  * { caret-color: transparent !important; }
  #ov { position: fixed; left: 0; top: 0; width: 1440px; height: 810px; transform-origin: 0 0; pointer-events: none; z-index: 2147483647; font-family: var(--font-geist-sans), sans-serif; }
  #ov .chip { position: absolute; white-space: nowrap; display: flex; align-items: center; gap: 9px; padding: 9px 15px 9px 13px; border-radius: 11px;
    background: linear-gradient(180deg, rgba(26,27,32,.95), rgba(14,15,18,.95)); border: 1px solid rgba(232,188,91,.5); box-shadow: 0 14px 40px rgba(0,0,0,.6), 0 0 20px rgba(232,188,91,.12);
    font: 500 17px var(--font-geist-sans), sans-serif; color: #efebe1; }
  #ov .chip small { font-weight: 400; color: #9aa0ab; font-size: 15px; }
  #ov .chip i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #ov svg.lines { position: absolute; inset: 0; overflow: visible; }
  #ov .cap { position: absolute; left: 70px; bottom: 50px; }
  #ov .cap .k { font: 500 14px var(--font-geist-sans); letter-spacing: .3em; text-transform: uppercase; color: #e8bc5b; }
  #ov .cap .k b { font: 600 14px var(--font-geist-mono); color: #8b7a55; margin-right: 12px; letter-spacing: .1em; }
  #ov .cap .t { font: 600 40px var(--font-cinzel), serif; letter-spacing: .02em; color: #efebe1; margin-top: 8px; text-shadow: 0 2px 20px rgba(0,0,0,.8); }
  #ov .cap .s { font: 400 19px var(--font-geist-sans); color: #c9c6bd; margin-top: 6px; text-shadow: 0 2px 14px rgba(0,0,0,.9); }
  #ov .band { position: absolute; left: 0; right: 0; bottom: 0; height: 240px; background: linear-gradient(180deg, transparent, rgba(4,4,6,.78) 50%, rgba(4,4,6,.94)); }
  #ov .wallet { position: absolute; right: 36px; top: 70px; width: 340px; border-radius: 18px; overflow: hidden; background: #16171c; border: 1px solid #2c2e36;
    box-shadow: 0 30px 80px rgba(0,0,0,.7); font-family: var(--font-geist-sans); color: #efebe1; }
  #ov .wallet .hd { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #25272e; font: 600 14px var(--font-geist-sans); }
  #ov .wallet .hd img { width: 26px; height: 26px; border-radius: 50%; }
  #ov .wallet .hd span { color: #8e939f; font-weight: 400; font-size: 12px; display: block; }
  #ov .wallet .bd { padding: 16px; }
  #ov .wallet .lbl { font: 600 11px var(--font-geist-sans); letter-spacing: .12em; color: #8e939f; text-transform: uppercase; }
  #ov .wallet .row { display: flex; justify-content: space-between; align-items: center; padding: 11px 0; border-bottom: 1px solid #22242a; font-size: 15px; }
  #ov .wallet .row b { font-weight: 600; }
  #ov .wallet .btns { display: flex; gap: 10px; padding: 14px 16px 16px; }
  #ov .wallet .btns div { flex: 1; text-align: center; padding: 12px 0; border-radius: 12px; font: 600 15px var(--font-geist-sans); }
  #ov .tl { position: absolute; right: 30px; top: 22px; display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-radius: 999px; background: rgba(14,15,18,.9);
    border: 1px solid rgba(232,188,91,.45); font: 600 15px var(--font-geist-sans); color: #efebe1; }
  #ov .tl b { font: 600 15px var(--font-geist-mono); color: #e8bc5b; }
  #ov .flash { position: absolute; inset: 0; background: radial-gradient(circle at 50% 45%, rgba(255,246,220,.95), rgba(255,214,140,.5) 35%, transparent 75%); opacity: 0; }
  #ov .fade { position: absolute; inset: 0; background: #050506; opacity: 0; }
  `,
});
const OVERLAY_INIT = () => {
  if (document.getElementById("ov")) return;
  const ov = document.createElement("div");
  ov.id = "ov";
  ov.innerHTML = `
    <div class="band" id="ov-band" style="opacity:0"></div>
    <svg class="lines" id="ov-lines" width="1440" height="810"></svg>
    <div id="ov-chips"></div>
    <div class="cap" id="ov-cap" style="opacity:0"><div class="k"><b></b><span></span></div><div class="t"></div><div class="s"></div></div>
    <div class="wallet" id="ov-wallet" style="opacity:0">
      <div class="hd"><img src="/brand/moatpad-mark.svg"><div>Confirm transaction<span>moatpad.fun</span></div></div>
      <div class="bd">
        <div class="lbl">Estimated balance changes</div>
        <div class="row"><span>SOL</span><b style="color:#ff6b78" id="ov-wsol">−0.53 SOL</b></div>
        <div class="row"><span id="ov-wtk">KELP</span><b style="color:#2bd98a" id="ov-wtok">+17.6M</b></div>
        <div class="row" style="border:0"><span style="color:#8e939f">Network fee</span><span style="color:#8e939f">0.00007 SOL</span></div>
      </div>
      <div class="btns"><div style="background:#22242a;color:#c9c6bd">Cancel</div><div id="ov-approve" style="background:linear-gradient(180deg,#f7d98c,#e2b04e);color:#1a1405">Approve</div></div>
    </div>
    <div class="tl" id="ov-tl" style="opacity:0"><span>⏩ Time-lapse</span><b id="ov-tlclock">+0:00</b></div>
    <svg id="ov-cursor" width="30" height="30" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;opacity:0;filter:drop-shadow(0 4px 8px rgba(0,0,0,.6));transform-origin:4px 3px">
      <path d="M4 2.5v17.2l4.6-4.3 2.9 6.6 3-1.3-2.9-6.5h6.4z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>
    <div id="ov-rip" style="position:absolute;border-radius:50%;border:3px solid rgba(240,200,110,.95);box-shadow:0 0 18px rgba(240,200,110,.7);opacity:0"></div>
    <canvas id="ov-sparks" width="1440" height="810" style="position:absolute;inset:0"></canvas>
    <div class="flash" id="ov-flash"></div>
    <div class="fade" id="ov-fade"></div>`;
  document.documentElement.appendChild(ov);
};
await page.evaluate(OVERLAY_INIT);

// Applied before every frame: camera clip → overlay transform, element-anchored callouts, cursor, prompt, captions.
const APPLY = (st) => {
  const ov = document.getElementById("ov");
  const zoom = 1440 / st.cam.w;
  ov.style.left = `${st.cam.x}px`;
  ov.style.top = `${st.cam.y}px`;
  ov.style.transform = `scale(${1 / zoom})`;
  const toScreen = (x, y) => [(x - st.cam.x) * zoom, (y - st.cam.y) * zoom];
  const anchor = (a) => {
    if (a.sel || a.text) {
      const pool = [...document.querySelectorAll(a.textIn ?? "*")].filter((e) => e.getBoundingClientRect().width > 0);
      const el = (a.sel && document.querySelector(a.sel)) || pool.find((e) => e.childElementCount === 0 && e.textContent.trim() === a.text) || pool.filter((e) => e.textContent.trim().startsWith(a.text)).at(-1);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return toScreen(r.left + r.width * (a.fx ?? 0.5), r.top + r.height * (a.fy ?? 0.5));
    }
    return toScreen(a.x, a.y);
  };
  // callouts
  const chips = document.getElementById("ov-chips"), lines = document.getElementById("ov-lines");
  chips.innerHTML = "";
  lines.innerHTML = "";
  for (const c of st.callouts) {
    const p = anchor(c.at);
    if (!p || c.alpha <= 0) continue;
    const [x, y] = p, ex = x + c.dx * c.grow, ey = y + c.dy * c.grow;
    lines.insertAdjacentHTML("beforeend", `<line x1="${x}" y1="${y}" x2="${ex}" y2="${ey}" stroke="rgba(240,200,110,.85)" stroke-width="1.6" opacity="${c.alpha}"/>
      <circle cx="${x}" cy="${y}" r="${5 + c.pulse * 16}" fill="none" stroke="#f6d27a" stroke-width="1.6" opacity="${c.alpha * (1 - c.pulse)}"/>
      <circle cx="${x}" cy="${y}" r="4.5" fill="#f6d27a" opacity="${c.alpha}"/>`);
    const ax = c.dx > 0 ? "0%" : c.dx < 0 ? "-100%" : "-50%", ay = c.dx === 0 ? (c.dy < 0 ? "-100%" : "0%") : "-50%";
    chips.insertAdjacentHTML("beforeend", `<div class="chip" style="left:${x + c.dx}px;top:${y + c.dy}px;opacity:${c.alpha};transform:translate(${ax},${ay}) scale(${0.94 + 0.06 * c.alpha})"><i style="background:${c.color};box-shadow:0 0 10px ${c.color}"></i><span>${c.text}</span></div>`);
  }
  // caption
  const cap = document.getElementById("ov-cap");
  cap.style.opacity = st.caption.alpha;
  cap.style.transform = `translateY(${(1 - st.caption.alpha) * 18}px)`;
  cap.querySelector(".k b").textContent = st.caption.n;
  cap.querySelector(".k span").textContent = st.caption.kicker;
  cap.querySelector(".t").textContent = st.caption.title;
  cap.querySelector(".s").textContent = st.caption.sub;
  document.getElementById("ov-band").style.opacity = st.band;
  // cursor (page coordinates) and click ripple
  const cur = document.getElementById("ov-cursor");
  const [cx, cy] = toScreen(st.cursor.x, st.cursor.y);
  cur.style.opacity = st.cursor.alpha;
  cur.style.transform = `translate(${cx - 4}px, ${cy - 3}px) scale(${1 - 0.18 * st.cursor.press})`;
  const rip = document.getElementById("ov-rip");
  if (st.ripple) {
    const [rx, ry] = toScreen(st.ripple.x, st.ripple.y), sz = 10 + st.ripple.p * 70;
    Object.assign(rip.style, { opacity: 1 - st.ripple.p, width: `${sz}px`, height: `${sz}px`, left: `${rx - sz / 2}px`, top: `${ry - sz / 2}px` });
  } else rip.style.opacity = 0;
  // wallet prompt (screen space)
  const w = document.getElementById("ov-wallet");
  w.style.opacity = st.wallet.alpha;
  w.style.transform = `translateY(${(1 - st.wallet.alpha) * -20}px) scale(${0.96 + 0.04 * st.wallet.alpha})`;
  document.getElementById("ov-approve").style.filter = st.wallet.press ? "brightness(.85)" : "none";
  document.getElementById("ov-wsol").textContent = st.wallet.sol;
  document.getElementById("ov-wtok").textContent = st.wallet.tokens;
  document.getElementById("ov-wtk").textContent = st.wallet.ticker;
  // time-lapse badge
  document.getElementById("ov-tl").style.opacity = st.timelapse.alpha;
  document.getElementById("ov-tlclock").textContent = st.timelapse.clock;
  document.getElementById("ov-flash").style.opacity = st.flash;
  document.getElementById("ov-fade").style.opacity = st.fade;
  // sparks burst
  const ctx = document.getElementById("ov-sparks").getContext("2d");
  ctx.clearRect(0, 0, 1440, 810);
  if (st.sparks) {
    ctx.globalCompositeOperation = "lighter";
    for (const s of st.sparks.list) {
      const age = st.sparks.age;
      if (age > s.life) continue;
      const d = (1 - Math.exp(-2.4 * age)) / 2.4, d0 = (1 - Math.exp(-2.4 * Math.max(0, age - 0.04))) / 2.4;
      const x = st.sparks.x + s.vx * d, y = st.sparks.y + s.vy * d + 120 * age * age;
      const x0 = st.sparks.x + s.vx * d0, y0 = st.sparks.y + s.vy * d0 + 120 * Math.max(0, age - 0.04) ** 2;
      ctx.strokeStyle = s.hot ? `rgba(255,250,235,${1 - age / s.life})` : `rgba(255,205,120,${1 - age / s.life})`;
      ctx.lineWidth = s.w;
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x, y); ctx.stroke();
    }
  }
};

// ---- state, tweens, recording -------------------------------------------------------------------------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const out3 = (x) => 1 - Math.pow(1 - x, 3);
const FULL = { x: 0, y: 0, w: 1440 };
const st = {
  cam: { ...FULL }, cursor: { x: 1300, y: 760, alpha: 0, press: 0 }, ripple: null, callouts: [], band: 0,
  caption: { n: "", kicker: "", title: "", sub: "", alpha: 0 },
  wallet: { alpha: 0, press: false, sol: "−0.53 SOL", tokens: "+17.6M", ticker: "KELP" },
  timelapse: { alpha: 0, clock: "+0:00" }, flash: 0, fade: 0, sparks: null,
};
let frame = 0;
const tweens = [];
/** Animate numeric fields of `obj` to `to` over `dur` seconds (from the current frame). */
function tween(obj, to, dur, fn = ease) {
  const from = Object.fromEntries(Object.keys(to).map((k) => [k, obj[k]]));
  tweens.push({ obj, from, to, start: frame, frames: Math.max(1, Math.round(dur * FPS)), fn });
}
function stepTweens() {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const t = tweens[i], p = t.fn(clamp((frame - t.start) / t.frames));
    for (const k of Object.keys(t.to)) t.obj[k] = lerp(t.from[k], t.to[k], p);
    if (frame - t.start >= t.frames) tweens.splice(i, 1);
  }
}
const timers = [];
const at = (sec, fn) => timers.push({ frame: frame + Math.round(sec * FPS), fn });

let ff = null;
if (!stillsAt) {
  ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
}
const marks = {};
const started = Date.now();
/** Records `sec` seconds; the app's clock advances `speed` × real time (0 holds it). */
async function rec(sec, speed = 1) {
  const n = Math.round(sec * FPS);
  for (let i = 0; i < n; i++) {
    for (const t of timers.filter((t) => t.frame === frame)) await t.fn();
    stepTweens();
    for (const c of st.callouts) {
      c.alpha = clamp((frame - c.start) / 12) * (c.end ? clamp((c.end - frame) / 10) : 1);
      c.grow = out3(clamp((frame - c.start) / 14));
      c.pulse = ((frame - c.start) / 30) % 1;
    }
    st.callouts = st.callouts.filter((c) => !c.end || frame < c.end);
    if (st.ripple) { st.ripple.p = (frame - st.ripple.start) / 20; if (st.ripple.p >= 1) st.ripple = null; }
    if (st.sparks) { st.sparks.age = (frame - st.sparks.start) / FPS; if (st.sparks.age > 2.5) st.sparks = null; }
    if (speed > 0) await page.clock.runFor(Math.round((1000 / FPS) * speed));
    await page.evaluate(OVERLAY_INIT);
    await page.evaluate(APPLY, st);
    await page.waitForTimeout(12);
    const t = frame / FPS;
    if (stillsAt) {
      if (stillsAt.some((s) => Math.round(s * FPS) === frame)) await page.screenshot({ path: `still-demo-${t}.png`, clip: clip() });
    } else {
      const jpg = await page.screenshot({ type: "jpeg", quality: 93, clip: clip() });
      if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    frame++;
    if (frame % 150 === 0) process.stdout.write(`frame ${frame} (${Math.round((Date.now() - started) / 1000)}s)\n`);
  }
}
const clip = () => ({ x: st.cam.x, y: st.cam.y, width: st.cam.w, height: (st.cam.w * 9) / 16 });

// ---- helpers over the page -------------------------------------------------------------------------------
async function box(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`no box for ${locator}`);
  return b;
}
/** Camera onto a box (viewport px) filling `fill` of the frame; w is a multiple of 16 so clips stay whole pixels. */
function camFor(b, fill = 0.75, maxZoom = 1.6) {
  const zoom = clamp(Math.min((1440 * fill) / b.width, (810 * fill) / b.height), 1, maxZoom);
  const w = Math.round(1440 / zoom / 16) * 16, h = (w * 9) / 16;
  return { x: clamp(b.x + b.width / 2 - w / 2, 0, 1440 - w), y: clamp(b.y + b.height / 2 - h / 2 + h * 0.06, 0, 810 - h), w };
}
const camTo = (target, dur = 0.9) => tween(st.cam, target, dur);
async function moveTo(locator, dur = 0.7, fx = 0.5, fy = 0.5) {
  const b = await box(locator);
  const x = b.x + b.width * fx, y = b.y + b.height * fy;
  tween(st.cursor, { x, y, alpha: 1 }, dur);
  await rec(dur);
  await page.mouse.move(x, y);
}
async function click(locator, opts = {}) {
  if (locator) await moveTo(locator, opts.dur ?? 0.7, opts.fx, opts.fy);
  tween(st.cursor, { press: 1 }, 0.08);
  await rec(0.1, opts.speed ?? 1);
  st.ripple = { x: st.cursor.x, y: st.cursor.y, start: frame, p: 0 };
  if (!opts.fake) await page.mouse.click(st.cursor.x, st.cursor.y);
  tween(st.cursor, { press: 0 }, 0.12);
  await rec(0.15, opts.speed ?? 1);
}
async function type(text, perChar = 0.085) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await rec(perChar);
  }
}
function callout(atSpec, dx, dy, text, color = "#f2c76a", dur = null) {
  const c = { at: atSpec, dx, dy, text, color, start: frame, end: dur ? frame + Math.round(dur * FPS) : null, alpha: 0, grow: 0, pulse: 0 };
  st.callouts.push(c);
  return c;
}
const endCallouts = () => { for (const c of st.callouts) c.end = Math.min(c.end ?? Infinity, frame + 10); };
function caption(n, kicker, title, sub) {
  if (st.caption.alpha > 0.01) tween(st.caption, { alpha: 0 }, 0.2);
  at(st.caption.alpha > 0.01 ? 0.22 : 0, () => {
    Object.assign(st.caption, { n, kicker, title, sub });
    tween(st.caption, { alpha: 1 }, 0.45, out3);
    tween(st, { band: 1 }, 0.45);
  });
}
function burst(x, y) {
  let s = 99;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const list = Array.from({ length: 180 }, () => { const a = r() * 6.283, v = 200 + Math.pow(r(), 0.6) * 900; return { vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8 - 80, life: 0.6 + r() * 1.3, w: 1 + r() * 2.2, hot: r() > 0.6 }; });
  st.sparks = { x, y, list, start: frame, age: 0 };
}

// ======================================= THE DEMO =======================================================
// 1. the create page, connect the wallet (the creator wallet fills itself in)
await page.evaluate(() => window.scrollTo(0, 0));
const form = page.locator("form").first();
const nameIn = page.locator("#name"), tickerIn = page.locator("#ticker");
st.fade = 1;
tween(st, { fade: 0 }, 0.5);
caption("01", "Launch", "Launch a coin in one transaction.", "Your wallet confirms it, like on pump.fun.");
camTo(camFor(await box(page.locator("text=Coin details").first().locator("xpath=ancestor::div[contains(@class,'rounded')][1]")), 0.95), 1.2);
await rec(1.2);
await click(nameIn, { dur: 0.6 });
await type("Kelp Lord");
await click(tickerIn, { dur: 0.35 });
await type("KELP", 0.1);
callout({ sel: "#ticker", fx: 1, fy: 0.5 }, 70, -50, "Live preview as you type", "#f2c76a", 2.0);
await rec(0.6);

// connect: the creator field turns into "Your wallet"
const creator = page.locator("text=Creator wallet").first().locator("xpath=ancestor::div[2]");
await page.evaluate(() => document.querySelector("label[for=creatorWallet], #creatorWallet")?.scrollIntoView({ block: "center" }) ?? [...document.querySelectorAll("label")].find((l) => l.textContent.trim() === "Creator wallet")?.scrollIntoView({ block: "center" }));
await page.waitForTimeout(50);
const cb = await box(creator);
camTo(camFor({ x: cb.x - 20, y: cb.y - 150, width: cb.width + 40, height: cb.height + 190 }, 0.9), 0.8);
await rec(0.8);
await click(creator.getByRole("button", { name: "Connect wallet" }));
await rec(0.5);
await click(page.getByText("Demo Wallet").first(), { dur: 0.6 });
await rec(0.6);
callout({ text: "Your wallet", textIn: "span" }, 150, -64, "Creator wallet: filled in from your wallet", "#2bd98a", 2.4);
await rec(1.4);

// 2. choose the floor and the dev buy
caption("02", "Choose the floor", "15, 25 or 35% below the ATH.", "Written into the coin's vault at launch, forever.");
await page.evaluate(() => [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Choose the floor")?.scrollIntoView({ block: "start" }));
await page.evaluate(() => window.scrollBy(0, -90));
await page.waitForTimeout(50);
const floorCard = page.locator("text=Choose the floor").first().locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]");
camTo(camFor(await box(floorCard), 0.85), 0.8);
await rec(0.8);
await click(page.getByText("Loose", { exact: true }).first(), { dur: 0.6 });
callout({ text: "Buys back at 65% of ATH", textIn: "span", fx: 1, fy: 0.5 }, 64, -10, "The vault buys back 35% below the ATH", "#6aa6ff", 2.2);
await rec(1.6);
const devCard = page.locator("text=Dev buy (optional)").first().locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]");
await page.evaluate(() => window.scrollBy(0, 260));
await page.waitForTimeout(40);
const fb = await box(floorCard), db = await box(devCard);
camTo(camFor({ x: fb.x, y: fb.y + fb.height * 0.5, width: fb.width, height: db.y + db.height + 240 - (fb.y + fb.height * 0.5) }, 0.92), 0.7);
await rec(0.7);
await click(devCard.getByRole("button", { name: "0.5", exact: true }), { dur: 0.6 });
callout({ sel: "#devBuy", fx: 0.8, fy: 0 }, 40, -46, "Dev buy in the same transaction: no sniper gets in first", "#2bd98a", 2.0);
await rec(1.4);

// 3. launch: confirm in the wallet
caption("03", "Confirm", "One click in your wallet.", "Coin, vault and dev buy land together.");
const launchBtn = page.getByRole("button", { name: "Launch · confirm in wallet" });
camTo(FULL, 0.8);
await rec(0.5);
await click(launchBtn, { dur: 0.8 });
// preparing → the wallet asks: hold the app clock while the prompt is on screen (the mock wallet sends on its timer)
await rec(0.25);
const mb = await box(page.locator("[role=dialog]").first());
camTo((({ x, y, w }) => ({ x: Math.min(1440 - w, x + w * 0.14), y, w }))(camFor(mb, 0.62)), 0.6);
await rec(0.65);
tween(st.wallet, { alpha: 1 }, 0.35, out3);
await rec(1.3, 0);
await click(page.locator("#ov-approve"), { dur: 0.6, fake: true, speed: 0 });
st.wallet.press = true;
await rec(0.15, 0);
tween(st.wallet, { alpha: 0 }, 0.25);
st.wallet.press = false;
await rec(0.3, 0);
tween(st.cursor, { alpha: 0 }, 0.3);
// launching → live
for (let i = 0; i < 120; i++) {
  if (await page.getByText("is live", { exact: false }).first().isVisible().catch(() => false)) break;
  await rec(1 / FPS * 3);
}
marks.live = frame / FPS;
burst(720, 330);
st.flash = 0.7;
tween(st, { flash: 0 }, 0.6);
caption("04", "Live", "$KELP is live on pump.fun.", "With its own floor vault from the first second.");
await rec(1.8);
// the redirect to the coin page
for (let i = 0; i < 90; i++) {
  if (page.url().includes("/coin/")) break;
  await rec(1 / FPS * 3);
}
await rec(0.6);
marks.coin = frame / FPS;

// 4. the coin page, live: a scripted rally, a dump onto the floor, the vault's buyback, payouts
const mint = page.url().split("/coin/")[1].split(/[?#]/)[0];
await page.evaluate((m) => {
  const M = 60_000;
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  window.__holdfastMock.scriptPricePath(m, (ms) => {
    const t = ms / M;
    const wig = 1 + 0.035 * Math.sin(t * 9.3) + 0.02 * Math.sin(t * 23.1);
    if (t < 6) return (1.1 + 4.6 * smooth(t / 6)) * wig;
    if (t < 8.6) return 5.6 * wig;
    if (t < 9.8) return lerp(5.6, 2.0, smooth((t - 8.6) / 1.2));
    return (2.25 + 1.4 * smooth((t - 9.8) / 3)) * wig;
    function lerp(a, b, p) { return a + (b - a) * p; }
  });
}, mint);
await page.evaluate(() => window.scrollTo(0, 0));
caption("05", "Live trading", "Every trade feeds the coin's vault.", "40% floor · 25% holders · 15% creator · 10% treasury · 10% burn");
const TL = 40;
const t0 = await page.evaluate(() => Date.now());
const tlClock = async () => {
  const s = Math.round(((await page.evaluate(() => Date.now())) - t0) / 1000);
  st.timelapse.clock = `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
async function lapse(sec) {
  const n = Math.round((sec * FPS) / 3);
  for (let i = 0; i < n; i++) {
    await tlClock();
    await rec(3 / FPS, TL);
  }
}
const cardOf = (text) => page.locator(`text=${text}`).first().locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]");
const union = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) });
const scrollToCard = async (text, offset = 110) => {
  await page.evaluate(([t, o]) => {
    const el = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === t);
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o);
  }, [text, offset]);
  await page.waitForTimeout(40);
};
// a: the coin's first minutes: the 1-minute chart, market cap, floor and ATH
const topBox = union(await box(cardOf("Market cap")), await box(cardOf("Vault buyback")));
camTo(camFor({ ...topBox, height: topBox.height * 0.78 }, 0.97), 0.8);
await click(page.getByText("1m", { exact: true }).first(), { dur: 0.7 });
tween(st.cursor, { alpha: 0 }, 0.3);
tween(st.timelapse, { alpha: 1 }, 0.4);
await lapse(2.6);
callout({ text: "Floor MC", textIn: "dt", fx: 0.5, fy: 1 }, -60, 62, "Floor rises with every new ATH", "#6aa6ff", 3.4);
await lapse(1.2);
callout({ text: "ATH MC", textIn: "dt", fx: 0.5, fy: 1 }, 40, 112, "ATH, time-weighted", "#f2c76a", 2.4);
await lapse(2.6);
// b: the vault fills from the fees
caption("06", "Floor vault", "40% of every fee defends the floor.", "Floor and holder funds can never be withdrawn.");
await page.getByText("Defending the floor", { exact: true }).first().scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, 220));
await page.waitForTimeout(40);
const vb = await box(page.getByText("Defending the floor", { exact: true }).first().locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]"));
camTo(camFor({ x: vb.x - 300, y: vb.y, width: vb.width + 300, height: Math.min(vb.height, 340) }, 0.95), 0.7);
await lapse(1.2);
callout({ text: "Defending the floor", textIn: "div", fx: 0, fy: 0.5 }, -50, 10, "The coin's own vault, filling from fees", "#6aa6ff", 3.2);
await lapse(1.0);
callout({ text: "Holder pot", textIn: "*", fx: 0, fy: 0.5 }, -50, 40, "Holder pot: paid out every 2 minutes", "#f2c76a", 2.4);
await lapse(2.4);
// c: the dump onto the floor: the vault buys back
caption("07", "Buyback", "Price hits the floor, the vault buys back.", "10% of the vault per step, on its own.");
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(40);
const topBox2 = union(await box(cardOf("Market cap")), await box(cardOf("Vault buyback")));
camTo(camFor({ ...topBox2, height: topBox2.height * 0.85 }, 0.97), 0.6);
for (let i = 0; i < 40; i++) {
  await lapse(0.3);
  if (await page.evaluate((m) => window.__holdfastMock.defendsList(m, 5)?.length > 0, mint)) break;
}
marks.buyback = frame / FPS;
st.flash = 0.3;
tween(st, { flash: 0 }, 0.45);
callout({ text: "At floor", textIn: "*", fx: 0.5, fy: 1 }, 0, 70, "At the floor: the vault is buying", "#6aa6ff", 2.6);
await lapse(2.4);
// d: the buyback in the trades list
// the activity table (trades), not the top holders list
await page.evaluate(() => {
  const t = [...document.querySelectorAll("table")].find((x) => /account/i.test(x.innerText));
  window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY - 120);
});
await page.waitForTimeout(40);
const tb = await box(page.locator("table", { hasText: /account/i }).first());
camTo(camFor({ x: tb.x, y: tb.y - 40, width: tb.width, height: 330 }, 0.95), 0.6);
await lapse(0.9);
callout({ text: "Vault buy", textIn: "span", fx: 1, fy: 0.5 }, 70, -40, "The buyback, on-chain: tokens go to holders", "#6aa6ff", 2.4);
await lapse(2.4);
// e: payouts every 2 minutes
caption("08", "Holder payouts", "Holders get paid every 2 minutes.", "SOL + bought-back tokens, by tokens × weight.");
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(40);
const pb = await box(cardOf("Next payout in"));
camTo(camFor({ x: pb.x, y: pb.y, width: 620, height: 400 }, 0.92), 0.7);
await lapse(1.0);
callout({ text: "Next payout in", textIn: "span", fx: 1, fy: 0.5 }, 190, 34, "Every 2 minutes the holder pot is paid out", "#f2c76a", 3.2);
await lapse(3.4);
endCallouts();
tween(st.timelapse, { alpha: 0 }, 0.3);
tween(st.caption, { alpha: 0 }, 0.3);
tween(st, { band: 0, fade: 1 }, 0.5);
camTo(FULL, 0.6);
await lapse(0.6);
marks.end = frame / FPS;

if (ff) {
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
}
writeFileSync(resolve(stillsAt ? "demo-marks.json" : out.replace(/\.mp4$/, ".json")), JSON.stringify({ ...marks, frames: frame, seconds: frame / FPS }, null, 1));
console.log(JSON.stringify({ ...marks, seconds: frame / FPS }));
await browser.close();
