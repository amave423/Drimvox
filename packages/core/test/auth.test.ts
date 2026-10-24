import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./env";

/** The code the server writes to its log while no password is set. */
const CODE = "424242";
const PASSWORD = "correct horse";

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv({ setupCode: CODE });
});

afterEach(async () => {
  await env.closeAsync();
});

const send = (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  env.raw(method, path, { body, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

async function setUp(): Promise<string> {
  const res = await send("POST", "/api/auth/setup", { password: PASSWORD, code: CODE });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

describe("password sign-in", () => {
  it("stays closed until a password is set with the code from the server log", async () => {
    expect(await (await send("GET", "/api/auth/state")).json()).toEqual({ mode: "password", passwordSet: false, signedIn: false });
    expect((await send("GET", "/api/settings")).status).toBe(401);
    // The desktop's token means nothing here.
    expect((await env.call("GET", "/api/settings")).status).toBe(401);
    expect((await send("GET", "/api/health")).status).toBe(200);

    expect((await send("POST", "/api/auth/setup", { password: PASSWORD, code: "000000" })).status).toBe(403);
    expect((await send("POST", "/api/auth/setup", { password: "short", code: CODE })).status).toBe(400);

    const res = await send("POST", "/api/auth/setup", { password: PASSWORD, code: CODE });
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(/^drimvox_session=/);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Max-Age=2592000/);
    expect(header).not.toMatch(/Secure/i);
    const cookie = cookieOf(res);

    expect((await send("GET", "/api/settings", undefined, cookie)).status).toBe(200);
    expect(await (await send("GET", "/api/auth/state", undefined, cookie)).json()).toEqual({ mode: "password", passwordSet: true, signedIn: true });
    expect((await send("POST", "/api/auth/setup", { password: "another password", code: CODE })).status).toBe(409);

    // Only hashes are stored.
    const stored = JSON.stringify([env.db.sql.prepare("select * from settings").all(), env.db.sql.prepare("select * from sessions").all()]);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(cookie.split("=")[1]);
  });

  it("marks the cookie Secure behind HTTPS", async () => {
    const res = await send("POST", "/api/auth/setup", { password: PASSWORD, code: CODE }, undefined, { "X-Forwarded-Proto": "https" });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("signs in and out", async () => {
    await setUp();
    expect((await send("POST", "/api/auth/login", { password: "wrong password" })).status).toBe(401);
    const res = await send("POST", "/api/auth/login", { password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect((await send("GET", "/api/settings", undefined, cookie)).status).toBe(200);

    const out = await send("POST", "/api/auth/logout", undefined, cookie);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await send("GET", "/api/settings", undefined, cookie)).status).toBe(401);
  });

  it("makes you wait after five wrong passwords, whatever address the client claims", async () => {
    await setUp();
    // tailscale serve appends the real address; what comes before it is the client's own invention.
    const from = (i: number) => ({ "X-Forwarded-For": `10.0.0.${i}, 100.64.0.7` });
    for (let i = 0; i < 5; i++) expect((await send("POST", "/api/auth/login", { password: "wrong password" }, undefined, from(i))).status).toBe(401);
    expect((await send("POST", "/api/auth/login", { password: PASSWORD }, undefined, from(9))).status).toBe(429);
    // Another real address is not locked out.
    expect((await send("POST", "/api/auth/login", { password: PASSWORD }, undefined, { "X-Forwarded-For": "100.64.0.8" })).status).toBe(200);
  });

  it("refuses changes sent from another site", async () => {
    const cookie = await setUp();
    expect((await send("PATCH", "/api/settings", { theme: "dark" }, cookie, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await send("PATCH", "/api/settings", { theme: "dark" }, cookie, { Origin: "http://127.0.0.1" })).status).toBe(200);
  });

  it("changes the password and signs the other sessions out", async () => {
    const mine = await setUp();
    const other = cookieOf(await send("POST", "/api/auth/login", { password: PASSWORD }));
    expect((await send("POST", "/api/auth/password", { current: "wrong password", next: "new password 2" }, mine)).status).toBe(403);
    expect((await send("POST", "/api/auth/password", { current: PASSWORD, next: "new password 2" }, mine)).status).toBe(200);
    expect((await send("GET", "/api/settings", undefined, mine)).status).toBe(200);
    expect((await send("GET", "/api/settings", undefined, other)).status).toBe(401);
    expect((await send("POST", "/api/auth/login", { password: "new password 2" })).status).toBe(200);
  });

  it("ends sessions after 30 days", async () => {
    const cookie = await setUp();
    env.db.sql.prepare("update sessions set expires_at = ?").run(Date.now() - 1);
    expect((await send("GET", "/api/settings", undefined, cookie)).status).toBe(401);
  });
});
