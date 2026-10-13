// Draws Artel's icon (a sheet of paper on the stone desk, an ink "A", a red pencil stroke) and saves
// apps/desktop/build/icon.png at 1024 px; electron-builder makes the Windows .ico and Linux sizes from it.
// Needs Microsoft Edge or Chrome on this computer. Run: node scripts/make-icon.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");

const font = pathToFileURL(join(root, "node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff2")).href;
const tokens = readFileSync(join(root, "apps/web/src/styles/tokens.css"), "utf8");
const token = (name) => tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))[1];

const html = `<!doctype html><html><head><style>
@font-face { font-family: "Source Serif 4"; src: url("${font}") format("woff2"); font-weight: 600; }
html, body { margin: 0; background: transparent; }
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="stone" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34342f"/><stop offset="1" stop-color="${token("fg")}"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="960" height="960" rx="216" fill="url(#stone)"/>
  <g transform="rotate(-5 512 520)" filter="url(#shadow)">
    <rect x="232" y="150" width="560" height="720" fill="${token("sheet")}"/>
  </g>
  <g transform="rotate(-5 512 520)">
    <text x="512" y="672" text-anchor="middle" font-family="Source Serif 4" font-weight="600" font-size="520" fill="${token("ink")}">A</text>
    <path d="M304 744 C 424 712, 564 708, 724 732" fill="none" stroke="${token("pencil")}" stroke-width="30" stroke-linecap="round"/>
  </g>
</svg></body></html>`;

const out = join(root, "apps/desktop/build/icon.png");
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.locator("svg").screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(`Saved ${out}`);
