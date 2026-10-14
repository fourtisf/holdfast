// End-to-end smoke run + screenshots against a running mock-mode server.
//   NEXT_PUBLIC_USE_MOCKS=1 pnpm build && NEXT_PUBLIC_USE_MOCKS=1 pnpm start   (in another shell)
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm screenshots
// Checks every page for console errors and horizontal page overflow at desktop and mobile sizes.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../screenshots");
const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

const problems = [];
const shots = [];

function watch(page, label) {
  void page.addInitScript(() => {
    window.addEventListener("error", (e) => console.log("ERRDETAIL", e.message, e.filename, e.lineno, e.colno));
  });
  page.on("console", (msg) => {
    if (msg.text().startsWith("ERRDETAIL")) problems.push(`[${label}] ${msg.text()}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`[${label}] console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`[${label}] pageerror: ${err.message} @ ${page.url()}\n${err.stack ?? ""}`));
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "";
    if (!failure.includes("ERR_ABORTED")) problems.push(`[${label}] request failed: ${req.url()} ${failure}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().startsWith(BASE)) problems.push(`[${label}] HTTP ${res.status()}: ${res.url()}`);
  });
}

async function checkOverflow(page, label) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  if (scrollWidth > innerWidth) problems.push(`[${label}] horizontal overflow: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`);
}

// Full-page shots grow the viewport to the document height (instead of Playwright's fullPage) so fixed
// elements such as the mobile tab bar render where a user sees them.
async function shot(page, name, vp, { fullPage = true } = {}) {
  const file = path.join(OUT, `${name}-${vp}.png`);
  await page.mouse.move(1, 1); // keep the chart crosshair out of the shot
  if (fullPage) {
    const size = page.viewportSize();
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: size.width, height: Math.min(Math.max(height, size.height), 9000) });
    await page.waitForTimeout(500);
    await page.screenshot({ path: file });
    await page.setViewportSize(size);
    await page.waitForTimeout(200);
  } else {
    await page.screenshot({ path: file });
  }
  shots.push(file);
}

async function connectMockWallet(page) {
  await page.locator(".wallet-adapter-button-trigger").first().click();
  await page.getByRole("button", { name: /Demo Wallet \(mock\)/ }).click();
  await page
    .locator(".wallet-adapter-button-trigger", { hasText: "…" })
    .or(page.locator(".wallet-adapter-button-trigger", { hasText: ".." }))
    .first()
    .waitFor();
}

async function imageFixture(browser) {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await page.setContent(
    `<body style="margin:0"><div style="width:256px;height:256px;background:radial-gradient(circle at 30% 30%,#ffe08a,#ff7a59 45%,#7a1fa2);display:flex;align-items:center;justify-content:center;font:900 92px system-ui;color:#fff;text-shadow:0 6px 0 rgba(0,0,0,.25)">HF</div></body>`,
  );
  const buffer = await page.screenshot({ type: "png" });
  await page.close();
  return buffer;
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const png = await imageFixture(browser);

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    const page = await context.newPage();
    const label = (p) => `${vp.name} ${p}`;
    watch(page, vp.name);
    try {
      // Coins (grid + table)
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.locator('a[href^="/coin/"]').first().waitFor();
      await page.waitForTimeout(400);
      await checkOverflow(page, label("/"));
      await shot(page, "coins", vp.name);
      await page.getByRole("radio", { name: "Table view" }).click();
      await page.locator("table").waitFor();
      await checkOverflow(page, label("/ table"));
      await shot(page, "coins-table", vp.name, { fullPage: false });
      await page.getByRole("radio", { name: "Grid view" }).click();
      await page.getByRole("tab", { name: "Vault buying" }).click();
      await page.waitForTimeout(700);
      await shot(page, "coins-vault-buying", vp.name, { fullPage: false });
      await page.getByRole("tab", { name: "Newest" }).click();

      // Watchlist, filters and the USD toggle
      await page.getByRole("button", { name: /to watchlist$/ }).first().click();
      await page.getByRole("tab", { name: /Watchlist/ }).click();
      await page.waitForTimeout(700);
      if ((await page.locator('a[href^="/coin/"]').count()) !== 1) problems.push(`[${label("/ watchlist")}] expected exactly one starred coin`);
      await shot(page, "coins-watchlist", vp.name, { fullPage: false });
      await page.getByRole("tab", { name: "Newest" }).click();
      await page.getByRole("button", { name: /^Filters/ }).click();
      await page.getByRole("radio", { name: "Bonding curve" }).click();
      await page.waitForTimeout(700);
      await shot(page, "coins-filters", vp.name, { fullPage: false });
      await page.getByRole("button", { name: "Reset" }).click();
      await page.getByRole("button", { name: /^Filters/ }).click();
      if (vp.name === "desktop") {
        await page.getByRole("button", { name: "Show amounts in USD" }).click();
        await page.waitForTimeout(300);
        await shot(page, "coins-usd", vp.name, { fullPage: false });
        await page.getByRole("button", { name: "Show amounts in SOL" }).click();
      }

      // How it works modal
      await page.getByRole("button", { name: "How it works" }).first().click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(300);
      await shot(page, "how-it-works", vp.name, { fullPage: false });
      await page.getByRole("button", { name: "Got it" }).click();

      // Connect the mock wallet, then open a coin the demo wallet holds
      await connectMockWallet(page);
      await page.getByLabel("Search coins").fill("Kelp Lord");
      const kelp = await page.locator('a[href^="/coin/"]', { hasText: "Kelp Lord" }).first().getAttribute("href");
      await page.getByLabel("Search coins").fill("");
      await page.goto(`${BASE}${kelp}`, { waitUntil: "networkidle" });
      await page.locator("canvas").first().waitFor();
      await page.getByText("Share of next round").waitFor();
      await page.waitForTimeout(3500); // let a few live trades arrive
      await checkOverflow(page, label("/coin"));
      await shot(page, "coin", vp.name);
      await page
        .getByRole("button", { name: "1h" })
        .or(page.getByRole("radio", { name: "1h" }))
        .first()
        .click();
      await page.waitForTimeout(800);
      await page.getByRole("tab", { name: /Holders/ }).click();
      await page.waitForTimeout(600);
      await shot(page, "coin-holders", vp.name);
      await page.getByRole("tab", { name: /Vault buys/ }).click();
      await page.waitForTimeout(600);
      await checkOverflow(page, label("/coin tabs"));

      // Comments: sign and post as the mock wallet
      await page.getByRole("tab", { name: /Comments/ }).click();
      await page.getByLabel("Comment").fill("diamond hands only, the floor keeps rising");
      await page.getByRole("button", { name: "Post", exact: true }).click();
      await page.locator("li", { hasText: "diamond hands only, the floor keeps rising" }).first().waitFor({ timeout: 10_000 });
      await page.getByLabel("Comment").scrollIntoViewIfNeeded();
      await checkOverflow(page, label("/coin comments"));
      await shot(page, "coin-comments", vp.name, { fullPage: false });

      // Rounds → in-browser verification
      await page.getByRole("tab", { name: /Rounds/ }).click();
      await page.getByRole("link", { name: "Verify" }).first().click();
      await page.getByText("Recomputed in your browser").waitFor();
      await page.waitForTimeout(600);
      if (!(await page.getByText("Every payout follows from the inputs").count())) problems.push(`[${label("/round")}] mock round did not verify`);
      await checkOverflow(page, label("/round"));
      await shot(page, "round-verify", vp.name);
      // The OG card of this coin renders on the server
      const og = await page.request.get(`${BASE}${kelp}/opengraph-image`);
      if (!og.ok() || !(og.headers()["content-type"] ?? "").startsWith("image/png")) problems.push(`[${label("og")}] opengraph-image: HTTP ${og.status()}`);
      else if (vp.name === "desktop") {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(OUT, "og-coin.png"), await og.body());
      }
      await page.goto(`${BASE}${kelp}`, { waitUntil: "networkidle" });
      await page.getByText("Share of next round").waitFor();

      // Buy flow with the mock wallet
      await page.getByRole("button", { name: "0.5 SOL" }).click();
      await page.getByText(/You receive/).waitFor();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: /^Buy \$/ }).click();
      await page.getByText("Trade confirmed").waitFor({ timeout: 15_000 });
      await page.getByText("Trade confirmed").scrollIntoViewIfNeeded();
      await shot(page, "coin-trade", vp.name, { fullPage: false });

      // Profile of the demo wallet, opened by address in a fresh (disconnected) context
      await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
      await page.getByText("Your profile").waitFor();
      const target = await page.locator("[data-wallet]").getAttribute("data-wallet");
      const fresh = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
      const profilePage = await fresh.newPage();
      watch(profilePage, vp.name);
      await profilePage.goto(`${BASE}/profile?wallet=${encodeURIComponent(target)}`, { waitUntil: "networkidle" });
      await profilePage.getByText("Positions").first().waitFor();
      await profilePage.getByText("Recent payouts").waitFor();
      await profilePage.waitForTimeout(400);
      await checkOverflow(profilePage, label("/profile"));
      await shot(profilePage, "profile", vp.name);
      await profilePage.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
      await profilePage.getByText("Connect a wallet to see your earnings").waitFor();
      await shot(profilePage, "profile-disconnected", vp.name, { fullPage: false });
      await fresh.close();

      // Leaderboard and a creator page
      await page.goto(`${BASE}/leaderboard`, { waitUntil: "networkidle" });
      await page.getByRole("tab", { name: "Top earners" }).waitFor();
      await page.locator("tbody tr").first().waitFor();
      await checkOverflow(page, label("/leaderboard"));
      await shot(page, "leaderboard", vp.name);
      await page.getByRole("tab", { name: "Creators" }).click();
      await page.locator('a[href^="/creator/"]').first().waitFor();
      const creator = await page.locator('a[href^="/creator/"]').first().getAttribute("href");
      await page.goto(`${BASE}${creator}`, { waitUntil: "networkidle" });
      await page.getByText("Paid to holders").first().waitFor();
      await page.locator('a[href^="/coin/"]').first().waitFor();
      await page.waitForTimeout(400);
      await checkOverflow(page, label("/creator"));
      await shot(page, "creator", vp.name);

      // Create → deposit modal → live → redirect
      await page.goto(`${BASE}/create`, { waitUntil: "networkidle" });
      await page.getByLabel("Name").fill("Barnacle Baron");
      await page.getByLabel("Ticker").fill("baron");
      await page.getByLabel("Description").fill("Clings to the floor like it owes him money. Fees go to the vault, holders get paid.");
      await page.locator('input[type="file"]').setInputFiles({ name: "baron.png", mimeType: "image/png", buffer: png });
      await page.getByText("Image uploaded").waitFor({ timeout: 10_000 });
      await page.getByLabel("X").fill("@barnaclebaron");
      await page.getByLabel("Website").fill("barnaclebaron.fun");
      await page.getByRole("radio", { name: /35%/ }).click();
      await page.getByRole("button", { name: "0.5", exact: true }).click();
      await page.waitForTimeout(300);
      await checkOverflow(page, label("/create"));
      await shot(page, "create", vp.name);
      await page.getByRole("button", { name: /^Launch · send/ }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByText("Send exactly").waitFor();
      await page.waitForTimeout(300);
      await shot(page, "deposit-awaiting", vp.name, { fullPage: false });
      await page.getByText("Deposit received", { exact: true }).first().waitFor({ timeout: 15_000 });
      await page.getByText(/Creating your coin|Preparing launch/).waitFor({ timeout: 15_000 });
      await shot(page, "deposit-received", vp.name, { fullPage: false });
      await page.getByText(/is live/).waitFor({ timeout: 20_000 });
      await shot(page, "deposit-live", vp.name, { fullPage: false });
      await page.waitForURL(/\/coin\//, { timeout: 15_000 });
      await page.getByText("Barnacle Baron").first().waitFor();
      await page.locator("canvas").first().waitFor();
      await page.waitForTimeout(2500);
      await checkOverflow(page, label("/coin (launched)"));
      await shot(page, "launched-coin", vp.name);
    } catch (err) {
      await page.screenshot({ path: path.join(OUT, `failure-${vp.name}.png`) }).catch(() => {});
      throw err;
    }

    await context.close();
  }

  await browser.close();
  console.log(`Saved ${shots.length} screenshots to ${OUT}`);
  for (const s of shots) console.log(`  ${path.relative(process.cwd(), s)}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nNo console errors, failed requests or horizontal overflow.");
}

run().catch((err) => {
  console.error(err);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
});
