import { tool, type ToolSet } from "ai";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";

/** mail.tm: free temporary inboxes with an open API; a test gives a fake. */
let API = "https://api.mail.tm";
export function setMailApi(url: string | undefined): void {
  API = url ?? "https://api.mail.tm";
}

interface Inbox {
  address: string;
  token: string;
}

const LINK = /https?:\/\/[^\s"'<>)\]]+/g;
const CODE = /(?<![\d-])\d{4,8}(?![\d-])/g;

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The mail service answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * A throwaway inbox for sign-ups (docs/specs/tools.md, asked for: the agent registers on a site and needs the letter
 * with the link or the code). The user's own mail is never used; the inbox lives as long as the conversation's tools do.
 */
export function emailTools(hooks: Pick<ToolHooks, "onCall">): ToolSet {
  const inboxes: Inbox[] = [];
  const run = async (name: string, input: string, work: () => Promise<string>) => {
    hooks.onCall({ callId: randomUUID(), name, input });
    try {
      return await work();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const inbox = (address?: string) => {
    const found = address ? inboxes.find((i) => i.address === address) : inboxes.at(-1);
    if (!found) throw new Error("No inbox yet: call email_new first.");
    return found;
  };
  type Message = { id: string; from: { address: string }; subject: string; intro: string; createdAt: string };

  return {
    email_new: tool({
      description:
        "Make a new temporary email address for signing up on a site (the user's own mail is never used). Letters to it are read with email_inbox and email_read.",
      inputSchema: z.object({}),
      execute: () =>
        run("email_new", "", async () => {
          const domains = await call<{ "hydra:member": { domain: string; isActive: boolean }[] }>("/domains");
          const domain = domains["hydra:member"].find((d) => d.isActive)?.domain;
          if (!domain) throw new Error("The mail service has no domain now; try again later.");
          const address = `${randomBytes(5).toString("hex")}@${domain}`;
          const password = randomBytes(12).toString("base64url");
          await call("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
          const { token } = await call<{ token: string }>("/token", { method: "POST", body: JSON.stringify({ address, password }) });
          inboxes.push({ address, token });
          return `New address: ${address}`;
        }),
    }),
    email_inbox: tool({
      description: "The letters in the temporary inbox, the newest first; waits up to wait_seconds for one to come (a site's confirmation takes a while).",
      inputSchema: z.object({ address: z.string().optional(), wait_seconds: z.number().int().min(0).max(120).optional() }),
      execute: ({ address, wait_seconds }, o: { abortSignal?: AbortSignal }) =>
        run("email_inbox", address ?? "", async () => {
          const box = inbox(address);
          const until = Date.now() + (wait_seconds ?? 0) * 1000;
          for (;;) {
            const list = (await call<{ "hydra:member": Message[] }>("/messages", {}, box.token))["hydra:member"];
            if (list.length || Date.now() >= until || o.abortSignal?.aborted) {
              if (!list.length) return `No letters to ${box.address} yet.`;
              return list.map((m) => `${m.id} · from ${m.from.address} · ${m.subject} — ${m.intro}`).join("\n");
            }
            await new Promise((r) => setTimeout(r, 4000));
          }
        }),
    }),
    email_read: tool({
      description: "Read a letter of the temporary inbox by its id: its text, and the links and codes in it.",
      inputSchema: z.object({ id: z.string().min(1), address: z.string().optional() }),
      execute: ({ id, address }) =>
        run("email_read", id, async () => {
          const box = inbox(address);
          const m = await call<{ from: { address: string }; subject: string; text?: string; html?: string[] }>(`/messages/${encodeURIComponent(id)}`, {}, box.token);
          const html = (m.html ?? []).join("\n");
          const text = (m.text || html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")).replace(/\s+\n/g, "\n").trim();
          const links = [...new Set([...(text.match(LINK) ?? []), ...(html.match(LINK) ?? [])])].slice(0, 20);
          const codes = [...new Set(text.match(CODE) ?? [])].slice(0, 10);
          return [`From: ${m.from.address}`, `Subject: ${m.subject}`, "", text.slice(0, 8000), links.length ? `\nLinks:\n${links.join("\n")}` : "", codes.length ? `\nCodes: ${codes.join(", ")}` : ""].join("\n");
        }),
    }),
  };
}
