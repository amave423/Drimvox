// Renders Drimvox's mark (apps/web/src/assets/logo.svg, the one source of the logo) to apps/desktop/build/icon.png
// at 1024 px, from which electron-builder makes the Windows .ico and Linux sizes, and the installer's pictures (the
// sidebar and the header, 24-bit BMP as NSIS wants them) with the mark and the name.
// Needs Microsoft Edge or Chrome on this computer. Run: node scripts/make-icon.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");

const logo = readFileSync(join(root, "apps/web/src/assets/logo.svg"), "utf8");
const build = join(root, "apps/desktop/build");
mkdirSync(build, { recursive: true });
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));

// The app's icon: the mark alone, with a small clear margin as system icons have.
{
  const svg = logo.replace("<svg ", '<svg width="960" height="960" ');
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<!doctype html><html><head><style>html, body { margin: 0; background: transparent; } body { padding: 32px; width: 960px; height: 960px; }</style></head><body>${svg}</body></html>`);
  await page.screenshot({ path: join(build, "icon.png"), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  await page.close();
}

/** One installer picture: the mark and the name on the app's paper, saved as a 24-bit BMP. */
async function picture(file, width, height, body) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>
      html, body { margin: 0; width: ${width}px; height: ${height}px; background: #eeefea; color: #22211e; font-family: Georgia, "Times New Roman", serif; }
    </style></head><body>${body}</body></html>`,
  );
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  // The page reads its own picture back as pixels: no image library needed for the BMP.
  const pixels = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, img.width, img.height).data);
  }, png.toString("base64"));
  await page.close();
  writeFileSync(join(build, file), bmp(width, height, pixels));
}

/** A bottom-up 24-bit BMP from RGBA pixels. */
function bmp(width, height, rgba) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const out = Buffer.alloc(size);
  out.write("BM", 0);
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    const at = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[at + x * 3] = rgba[i + 2];
      out[at + x * 3 + 1] = rgba[i + 1];
      out[at + x * 3 + 2] = rgba[i];
    }
  }
  return out;
}

const mark = (size) => logo.replace("<svg ", `<svg width="${size}" height="${size}" `);
await picture(
  "installerSidebar.bmp",
  164,
  314,
  `<div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; border-bottom: 5px solid #2b4c7e; box-sizing: border-box;">
     ${mark(76)}<div style="font-size: 27px; font-weight: 700;">Drimvox</div>
   </div>`,
);
await picture(
  "installerHeader.bmp",
  150,
  57,
  `<div style="height: 100%; display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding-right: 14px; box-sizing: border-box; background: #fcfcfa;">
     ${mark(24)}<div style="font-size: 17px; font-weight: 700;">Drimvox</div>
   </div>`,
);
await browser.close();
console.log(`Saved the icon and the installer's pictures in ${build}`);
