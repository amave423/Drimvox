import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_HTTP, codexOverHttp } from "../src/cli/codex-http";
import { CLI_KINDS } from "../src/cli/kinds";

const auth = (body: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "codex-auth-")), "auth.json");
  writeFileSync(file, body);
  return file;
};

describe("Codex over HTTPS", () => {
  it("is used with a ChatGPT sign-in", () => {
    expect(codexOverHttp(auth(JSON.stringify({ auth_mode: "chatgpt" })))).toEqual(CODEX_HTTP);
  });

  it("is not used with an API key, a broken file or none", () => {
    expect(codexOverHttp(auth(JSON.stringify({ auth_mode: "apikey" })))).toEqual([]);
    expect(codexOverHttp(auth("{"))).toEqual([]);
    expect(codexOverHttp(join(tmpdir(), "no-such-codex", "auth.json"))).toEqual([]);
  });

  it("goes before resume, which takes no options of its own", () => {
    const args = CLI_KINDS.codex.args({ model: "default", mode: "write", resume: "abc", schema: null, web: false });
    const resume = args.indexOf("resume");
    const provider = args.indexOf('model_provider="drimvox-http"');
    if (provider >= 0) expect(provider).toBeLessThan(resume);
    expect(args.at(-1)).toBe("-");
  });
});
