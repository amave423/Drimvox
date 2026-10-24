// GitHub for tests: the device flow, the user, and repositories created as bare repositories in a temp folder.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FAKE_TOKEN = "gho_fake_token_for_tests";

/** `pending`: how many polls answer "authorization_pending" first; `deny`: the user refuses. */
export async function startFakeGithub({ pending = 1, deny = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "drimvox-fake-github-"));
  const repos = new Map();
  const requests = [];
  let polls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const type = req.headers["content-type"] ?? "";
    const body = !raw ? {} : type.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const path = new URL(req.url, "http://x").pathname;
    requests.push({ method: req.method, path, auth: req.headers.authorization ?? null, body });
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.method === "POST" && path === "/login/device/code") {
      return json(200, { device_code: "device-1", user_code: "ABCD-1234", verification_uri: `${origin}/login/device`, expires_in: 900, interval: 0 });
    }
    if (req.method === "POST" && path === "/login/oauth/access_token") {
      polls++;
      if (deny) return json(200, { error: "access_denied" });
      if (polls <= pending) return json(200, { error: "authorization_pending" });
      return json(200, { access_token: FAKE_TOKEN, token_type: "bearer", scope: "repo" });
    }
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return json(401, { message: "Bad credentials" });
    if (req.method === "GET" && path === "/user") return json(200, { login: "octo" });
    if (req.method === "POST" && path === "/user/repos") {
      if (repos.has(body.name)) {
        return json(422, { message: "Repository creation failed.", errors: [{ resource: "Repository", field: "name", message: "name already exists on this account" }] });
      }
      const bare = join(dir, `${body.name}.git`);
      execFileSync("git", ["init", "-q", "--bare", bare]);
      repos.set(body.name, { bare, private: body.private });
      return json(201, { full_name: `octo/${body.name}`, html_url: `${origin}/octo/${body.name}`, clone_url: pathToFileURL(bare).href, private: body.private });
    }
    return json(404, { message: "Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    repos,
    requests,
    close: () =>
      new Promise((r) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          r();
        });
      }),
  };
}
