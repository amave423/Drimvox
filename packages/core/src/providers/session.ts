import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Which conversation the model requests of this async flow belong to: a chat's or a project's. OpenCode Go answers only
 * requests with a stable session id per conversation ("Apps that don't send a session ID can't use Go models").
 */
const current = new AsyncLocalStorage<string>();

/** Runs `fn` with its model requests counted to this conversation. */
export function inConversation<T>(id: string, fn: () => T): T {
  return current.run(id, fn);
}

/** Requests made outside any conversation (a model check, a title) share one session for this run of Drimvox. */
const loose = randomUUID();

/** The session id OpenCode expects: ses_ and letters and digits. */
export function sessionId(): string {
  return `ses_${(current.getStore() ?? loose).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}
