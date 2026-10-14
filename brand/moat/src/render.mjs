import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const [,, out, ...variants] = process.argv;
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const v of variants) {
  const p = await b.newPage({ viewport: { width: 1400, height: 1400 } });
  p.on("pageerror", (e) => console.log("pageerror", e.message));
  await p.goto(`http://127.0.0.1:8765/scene.html?v=${v}`);
  await p.waitForFunction(() => document.title === "done", null, { timeout: 120000 });
  const data = await p.evaluate(() => window.__png);
  writeFileSync(`${out}/${v}.png`, Buffer.from(data.split(",")[1], "base64"));
  await p.close();
  console.log("rendered", v);
}
await b.close();
