import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forgetSetupCode, loadSecretKey, loadSetupCode, readConfig, setupCode, tailscaleName } from "../src/config";

describe("server settings", () => {
  it("keeps data in ~/.local/share/drimvox on port 4317 unless told otherwise", () => {
    expect(readConfig({}, "/home/artem")).toEqual({ dataDir: join("/home/artem", ".local", "share", "drimvox"), port: 4317, hosts: [] });
    expect(readConfig({ DRIMVOX_DATA_DIR: "/srv/drimvox", DRIMVOX_PORT: "5000", DRIMVOX_HOSTS: "drimvox.lan, box" }, "/home/artem")).toEqual({
      dataDir: "/srv/drimvox",
      port: 5000,
      hosts: ["drimvox.lan", "box"],
    });
    expect(() => readConfig({ DRIMVOX_PORT: "abc" }, "/home/artem")).toThrow(/DRIMVOX_PORT/);
  });

  it("learns the machine's Tailscale name from `tailscale status --json`", () => {
    const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "drimvox-box.tail1234.ts.net.", HostName: "drimvox-box" } });
    expect(tailscaleName(status)).toBe("drimvox-box.tail1234.ts.net");
    expect(tailscaleName(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "" } }))).toBeNull();
    expect(tailscaleName("not json")).toBeNull();
  });

  it("creates the key file once, readable only by its owner, and reuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "drimvox-server-"));
    const key = loadSecretKey(dir);
    expect(key).toHaveLength(32);
    expect(loadSecretKey(dir).equals(key)).toBe(true);
    expect(readFileSync(join(dir, "secret.key"))).toHaveLength(32);
    if (process.platform !== "win32") expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
  });

  // Seen in WSL: the server restarted before the first sign-in and the code the installer printed no longer worked.
  it("keeps the setup code across restarts until the password is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "drimvox-server-"));
    const code = loadSetupCode(dir);
    expect(code).toMatch(/^\d{6}$/);
    expect(loadSetupCode(dir)).toBe(code);
    if (process.platform !== "win32") expect(statSync(join(dir, "setup-code")).mode & 0o777).toBe(0o600);
    forgetSetupCode(dir);
    expect(existsSync(join(dir, "setup-code"))).toBe(false);
  });

  it("makes six-digit setup codes", () => {
    const codes = new Set(Array.from({ length: 20 }, setupCode));
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(1);
  });
});
