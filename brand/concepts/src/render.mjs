import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
const [,, dir, out] = process.argv;
const b = await chromium.launch();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".html") && (f.startsWith("board-") || f === "overview.html"))) {
  const p = await b.newPage({ viewport: { width: 1600, height: f === "overview.html" ? 960 : 1000 } });
  await p.setContent(readFileSync(`${dir}/${f}`, "utf8"));
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${out}/${f.replace(".html", ".png")}` });
  await p.close();
}
await b.close();
