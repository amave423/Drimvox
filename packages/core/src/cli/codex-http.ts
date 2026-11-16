import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex signed in with ChatGPT talks over plain HTTPS instead of a WebSocket. Seen live in Russia: the WebSocket to
 * chatgpt.com never opened, Codex waited 15 s for it five times ("Reconnecting... 5/5") and the turn failed with nothing
 * said; the same request over HTTPS answered in 9 s. The built-in provider cannot be changed, so an equal one is named.
 */
export const CODEX_HTTP = [
  "-c",
  'model_providers.drimvox-http={name="OpenAI",base_url="https://chatgpt.com/backend-api/codex",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
  "-c",
  'model_provider="drimvox-http"',
];

/** Only for a ChatGPT sign-in: an API key goes to api.openai.com, which this provider does not. */
export function codexOverHttp(authFile = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")): string[] {
  try {
    const auth = JSON.parse(readFileSync(authFile, "utf8")) as { auth_mode?: unknown };
    return auth.auth_mode === "chatgpt" ? CODEX_HTTP : [];
  } catch {
    return [];
  }
}
