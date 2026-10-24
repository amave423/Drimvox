import { describe, expect, it } from "vitest";
import { siteIcon } from "./siteIcons";

describe("a popular site's mark for a link", () => {
  it("is found by the host or a parent domain", () => {
    expect(siteIcon("https://github.com/amave423/Drimvox")?.title).toBe("GitHub");
    expect(siteIcon("https://www.youtube.com/watch?v=1")?.title).toBe("YouTube");
    expect(siteIcon("https://ru.wikipedia.org/wiki/Python")?.title).toBe("Wikipedia");
  });

  it("is none for other sites, lookalikes and what is not an address", () => {
    expect(siteIcon("https://example.com/")).toBeNull();
    expect(siteIcon("https://notgithub.com/")).toBeNull();
    expect(siteIcon("mailto:a@b.c")).toBeNull();
    expect(siteIcon(undefined)).toBeNull();
  });
});
