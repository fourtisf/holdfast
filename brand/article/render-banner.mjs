// Renders banner.html to banner.png (3000 x 1200, the 5:2 header X recommends for Articles).
// Run from apps/web, where Playwright is installed:
//   cp ../../brand/article/render-banner.mjs .banner.mjs && node .banner.mjs; rm .banner.mjs
import { chromium } from "playwright";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 600 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(resolve("../../brand/article/banner.html")).href);
await page.evaluate(() => window.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: resolve("../../brand/article/banner.png") });
await browser.close();
console.log("wrote brand/article/banner.png");
