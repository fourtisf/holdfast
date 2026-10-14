import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
const [,, dir, out] = process.argv;
const b = await chromium.launch();
for (const f of readdirSync(dir).filter((f) => /^(board-|banner-|overview)/.test(f) && f.endsWith(".html"))) {
  const [w, h] = f.startsWith("banner") ? [1500, 500] : f.startsWith("overview") ? [1600, 740] : [1600, 1000];
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.setContent(readFileSync(`${dir}/${f}`, "utf8"));
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/${f.replace(".html", ".png")}` });
  await p.close();
}
await b.close();
