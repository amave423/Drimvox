import { describe, expect, it } from "vitest";
import { RelayBrowser } from "../src/browser/relay";

// Seen live: a tab out of sight never answered a device emulation, and a project's agent waited twenty minutes.
describe("the window's browser", () => {
  it("fails a request it does not answer in time, instead of waiting for ever", async () => {
    const browser = new RelayBrowser(() => new Promise(() => {}), 50);
    await expect(browser.command("Emulation.setDeviceMetricsOverride", {}, "t1")).rejects.toThrow(/did not answer "command"/);
  });

  it("gives the answer it gets", async () => {
    const browser = new RelayBrowser(async (op, args) => ({ op, method: args[0] }), 50);
    await expect(browser.command("Page.reload")).resolves.toEqual({ op: "command", method: "Page.reload" });
  });
});
