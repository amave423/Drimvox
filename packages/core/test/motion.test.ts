import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingMotion } from "../src/work/design-review";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drimvox-motion-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Seen live: "beautiful and animated" came out still, and screenshots cannot see motion.
describe("motion asked for", () => {
  it("is missing when the pages have next to none", () => {
    writeFileSync(join(dir, "style.css"), "body { color: red; }\n.btn { transition: color 0.2s; }\n");
    expect(missingMotion(dir, "Сайт погоды, красивый и анимированный")).toMatch(/Motion was asked for/);
  });

  it("is there when the styles move", () => {
    writeFileSync(join(dir, "style.css"), "@keyframes rise {}\n.a { animation: rise 1s; }\n.b { transition: all .2s; }\n.c { transition: opacity .3s; }\n");
    expect(missingMotion(dir, "с анимацией")).toBeNull();
  });

  it("is not asked about when nobody asked for motion", () => {
    writeFileSync(join(dir, "style.css"), "body { color: red; }\n");
    expect(missingMotion(dir, "Простой сайт клиники")).toBeNull();
  });
});
