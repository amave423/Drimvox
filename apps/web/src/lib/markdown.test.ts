import { describe, expect, it } from "vitest";
import { normalizeMath } from "./markdown";

describe("normalizeMath", () => {
  it("turns LaTeX brackets into dollar signs that Markdown understands", () => {
    expect(normalizeMath("Площадь \\(S = \\pi r^2\\), а ещё\n\\[E = mc^2\\]")).toBe("Площадь $S = \\pi r^2$, а ещё\n$$E = mc^2$$");
  });

  it("leaves code alone", () => {
    const code = "```js\nconst re = /\\(x\\)/;\n```\nи `\\(y\\)` в строке";
    expect(normalizeMath(code)).toBe(code);
  });

  it("keeps dollar math as it is", () => {
    expect(normalizeMath("Это $a^2 + b^2$ и $$\\int_0^1 x\\,dx$$")).toBe("Это $a^2 + b^2$ и $$\\int_0^1 x\\,dx$$");
  });
});
