// Captures the web app (mock mode, NEXT_PUBLIC_USE_MOCKS=1, served on :3311) for tour.html: full-page and viewport
// screenshots at 2x, typing states of the create form, and the page-coordinate boxes of every element the tour
// zooms into, points at or labels (brand/video/tour/data.json). Run from apps/web, where Playwright is installed:
//   cp ../../brand/video/capture-tour.mjs .capture.mjs && node .capture.mjs; rm .capture.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.TOUR_BASE ?? "http://localhost:3311";
const OUT = "../../brand/video/tour";
const VIEW = { width: 1600, height: 1000 };
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
const data = { view: VIEW, shots: {} };

async function settle(ms = 1200) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) if (el.childElementCount === 0 && /MOCK DATA/i.test(el.textContent ?? "")) el.style.display = "none";
    // freeze the payout countdown and other ticking text where possible: animations off
    const s = document.createElement("style");
    s.textContent = "*{animation:none!important;transition:none!important;caret-color:transparent!important}";
    document.head.appendChild(s);
  });
}

/** Page-coordinate boxes (CSS px from the page's top-left) of the elements named by `specs`. */
async function boxes(specs) {
  return page.evaluate((specs) => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
    const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    // deepest visible element whose text matches
    const find = (text, root = document.body, exact = false) => {
      let best = null;
      for (const el of root.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const t = norm(el.innerText);
        if (exact ? t === norm(text) : t.includes(norm(text))) if (!best || r.width * r.height <= best.getBoundingClientRect().width * best.getBoundingClientRect().height) best = el;
      }
      return best;
    };
    const bordered = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderRadius) > 4) return e;
      }
      return el;
    };
    const wide = (el, minW) => { for (let e = el; e; e = e.parentElement) if (e.getBoundingClientRect().width >= minW) return e; return el; };
    const out = {};
    for (const [key, s] of Object.entries(specs)) {
      let el = s.sel ? document.querySelector(s.sel) : find(s.text, s.in ? (out[`__${s.in}`] ?? document.body) : document.body, s.exact);
      if (!el) { out[key] = null; continue; }
      if (s.card) el = bordered(el);
      if (s.row) el = wide(el, s.row);
      out[`__${key}`] = el;
      out[key] = rect(el);
    }
    for (const k of Object.keys(out)) if (k.startsWith("__")) delete out[k];
    return out;
  }, specs);
}

async function shot(name, { full = false, extra = {} } = {}) {
  const file = `${name}.jpg`;
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: full, type: "jpeg", quality: 95 });
  const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, scrollY }));
  data.shots[name] = { file, full, pageH: full ? size.h : VIEW.height, scrollY: full ? 0 : size.scrollY, ...extra };
  return data.shots[name];
}

// ---- home ----------------------------------------------------------------------------------------------
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await settle(1800);
const home = await shot("home", { full: true });
home.boxes = await boxes({
  header: { sel: "header" },
  hero: { text: "Coins that defend their floor" },
  stats: { text: "Coins launched", card: true },
  statVault: { text: "In floor vaults", card: true },
  statPaid: { text: "Paid to holders", card: true },
  statBuy: { text: "Buybacks 24h", card: true },
  filters: { text: "Vault buying", exact: true },
  card: { text: "Starfish Steve", card: true },
  cardFloor: { text: "Floor −35%", in: "card", exact: true },
  cardBar: { text: "FLOOR", in: "card", row: 400 },
  cardVault: { text: "Vault", in: "card", exact: true },
  cardPaid: { text: "Paid out", in: "card", exact: true },
  launch: { text: "Launch a coin · 0.015 SOL", card: false },
});
await page.locator("header").first().screenshot({ path: `${OUT}/home-header.jpg`, type: "jpeg", quality: 95 });

// ---- coin page ---------------------------------------------------------------------------------------
const href = await page.locator('a[href^="/coin/"]').first().getAttribute("href");
data.coinHref = href;
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
await settle(2200);
const coin = await shot("coin", { full: true });
coin.boxes = await boxes({
  header: { sel: "header" },
  title: { text: "Starfish Steve", card: true },
  market: { text: "Market cap", card: true },
  chart: { text: "Vault buyback", card: true },
  trade: { text: "Slippage", card: true },
  buyInput: { sel: 'input[placeholder="0.00"]' },
  preset: { text: "0.5 SOL", exact: true },
  receive: { text: "You receive", card: true },
  share: { text: "Your share", card: true },
  vault: { text: "On-chain", card: true },
  defend: { text: "Defending the floor", card: true },
  holderPot: { text: "Holder pot", row: 330 },
  creatorRow: { text: "Creator share", row: 330 },
  treasuryRow: { text: "Moatpad treasury", row: 330, in: "vault" },
  burnRow: { text: "Burn bucket", row: 330 },
  payout: { text: "Next payout in", card: true },
  fees: { text: "Where creator fees go", card: true },
  hold: { text: "Hold longer, earn more", card: true },
});
await page.locator("header").first().screenshot({ path: `${OUT}/coin-header.jpg`, type: "jpeg", quality: 95 });
// trade: before and after a preset
const tradeEl = page.locator("text=Slippage").first().locator("xpath=ancestor::*[contains(@class,'rounded')][last()]");
await page.locator('input[placeholder="0.00"]').first().scrollIntoViewIfNeeded();
await page.locator("button", { hasText: /^0\.5 SOL$/ }).first().click();
await settle(900);
await shot("coin-trade", { full: true });

// ---- create ---------------------------------------------------------------------------------------------
await page.goto(`${BASE}/create`, { waitUntil: "networkidle" });
await settle(1500);
await page.evaluate(() => window.scrollTo(0, 0));
const typing = [];
const nameIn = page.locator("#name");
const tickerIn = page.locator("#ticker");
await shot("create-0");
typing.push("create-0");
const createBoxes = await boxes({
  name: { sel: "#name" },
  ticker: { sel: "#ticker" },
  preview: { text: "Preview", row: 400 },
  previewCard: { text: "Your coin", card: true },
  send: { text: "You send", card: true },
  launchBtn: { text: "Launch · send", card: false },
  creator: { sel: "#creatorWallet" },
});
data.shots["create-0"].boxes = createBoxes;
let i = 1;
for (const ch of "Kelp Lord") {
  await nameIn.press(ch === " " ? "Space" : ch);
  await page.waitForTimeout(120);
  await shot(`create-${i}`);
  typing.push(`create-${i++}`);
}
await tickerIn.click();
for (const ch of "KELP") {
  await tickerIn.press(ch);
  await page.waitForTimeout(120);
  await shot(`create-${i}`);
  typing.push(`create-${i++}`);
}
data.typing = typing;
data.shots[typing.at(-1)].boxes = await boxes({ name: { sel: "#name" }, ticker: { sel: "#ticker" }, previewCard: { text: "Kelp Lord", card: true }, send: { text: "You send", card: true } });
// floor + dev buy, further down: all three at one scroll position so the tour can crossfade between them
const floorTop = await page.evaluate(() => [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "Choose the floor").getBoundingClientRect().top + scrollY);
await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), Math.round(floorTop - 370));
await settle(500);
const floorA = await shot("create-floor");
floorA.boxes = await boxes({ floor: { text: "Choose the floor", card: true }, opt35: { text: "Loose", card: true }, opt25: { text: "Balanced", card: true }, explain: { text: "Floor = ATH", card: true }, dev: { text: "Dev buy (optional)", card: true }, previewCard: { text: "Kelp Lord", card: true }, send: { text: "You send", card: true }, launchBtn: { text: "Launch · send", card: false } });
await page.locator("text=Loose").first().click();
await settle(500);
const floorB = await shot("create-floor35");
floorB.boxes = await boxes({ floor: { text: "Choose the floor", card: true }, opt35: { text: "Loose", card: true }, previewCard: { text: "Kelp Lord", card: true } });
const devPreset = page.locator("button", { hasText: /^0\.5( SOL)?$/ }).first();
if (await devPreset.count()) await devPreset.click();
await settle(700);
const dev = await shot("create-dev");
dev.boxes = await boxes({ dev: { text: "Dev buy (optional)", card: true }, devPreset: { text: "0.5", exact: true, in: "dev" }, send: { text: "You send", card: true }, launchBtn: { text: "Launch · send", card: false }, devInput: { sel: "#devBuy" } });

// ---- leaderboard, verify, how it works -----------------------------------------------------------------
await page.goto(`${BASE}/leaderboard`, { waitUntil: "networkidle" });
await settle(1500);
const lb = await shot("leaderboard");
lb.boxes = await boxes({ title: { text: "Leaderboard" } });
await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
await settle(1200);
const roundLink = await page.locator('a[href*="/round/"]').first().getAttribute("href").catch(() => null);
if (roundLink) {
  await page.goto(`${BASE}${roundLink}`, { waitUntil: "networkidle" });
  await settle(1800);
  const v = await shot("verify");
  v.boxes = await boxes({ check: { text: "verif", card: true } });
  data.roundHref = roundLink;
}
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await settle(1200);
await page.locator("header").getByText("How it works").first().click();
await settle(900);
await shot("howitworks");

writeFileSync(`${OUT}/data.json`, JSON.stringify(data, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(data.shots).map(([k, v]) => [k, { full: v.full, pageH: v.pageH, boxes: v.boxes ? Object.fromEntries(Object.entries(v.boxes).map(([b, r]) => [b, r && [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]])) : undefined }])), null, 1));
await browser.close();
