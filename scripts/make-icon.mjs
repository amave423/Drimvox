// Renders Drimvox's mark (apps/web/src/assets/logo.svg, the one source of the logo) to apps/desktop/build/icon.png
// at 1024 px; electron-builder makes the Windows .ico and Linux sizes from it.
// Needs Microsoft Edge or Chrome on this computer. Run: node scripts/make-icon.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");

const svg = readFileSync(join(root, "apps/web/src/assets/logo.svg"), "utf8").replace("<svg ", '<svg width="960" height="960" ');
const html = `<!doctype html><html><head><style>html, body { margin: 0; background: transparent; } body { padding: 32px; width: 960px; height: 960px; }</style></head><body>${svg}</body></html>`;

const out = join(root, "apps/desktop/build/icon.png");
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(html);
// A small clear margin around the mark, as system icons have.
await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
console.log(`Saved ${out}`);
