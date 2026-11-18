import { describe, expect, it } from "vitest";
import { contextLevel } from "./context-level";

describe("the context bar's colour", () => {
  it("is green while there is room, amber from half and red from 80 %", () => {
    expect(contextLevel(0, 1000)).toBe("low");
    expect(contextLevel(499, 1000)).toBe("low");
    expect(contextLevel(500, 1000)).toBe("mid");
    expect(contextLevel(799, 1000)).toBe("mid");
    expect(contextLevel(800, 1000)).toBe("high");
    expect(contextLevel(5000, 1000)).toBe("high");
    expect(contextLevel(10, 0)).toBe("low");
  });
});
