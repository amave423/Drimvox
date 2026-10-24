import type { PageAction } from "@drimvox/shared";
import type { ModelInfo } from "@drimvox/shared";
import { streamText } from "ai";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPublicAddress } from "../internet/web";
import { languageModel } from "../providers/model";
import type { Connection } from "../providers/repo";

/** Photographs a page: the desktop app does it with a hidden Electron window. */
/** Photographs a page; with actions, it first goes through them in order (a scenario, docs/specs/project-work.md). */
export type Screenshotter = (url: string, size: { width: number; height: number }, actions?: PageAction[]) => Promise<Buffer>;

export interface Vision {
  conn: Connection;
  model: string;
  price: ModelInfo | undefined;
}

/** This computer's own servers (a dev server) and the public internet; not the local network. */
export function mayLookAt(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || isPublicAddress(url);
  } catch {
    return false;
  }
}

/** Screenshots of tasks, kept next to the database and served to the interface. */
export class Shots {
  constructor(readonly dir: string) {}

  save(png: Buffer): string {
    mkdirSync(this.dir, { recursive: true });
    const id = randomUUID();
    writeFileSync(join(this.dir, `${id}.png`), png);
    return id;
  }

  path(id: string): string | null {
    return /^[0-9a-f-]{36}$/.test(id) ? join(this.dir, `${id}.png`) : null;
  }
}

/** A picture for the vision model. */
export interface Picture {
  data: Buffer;
  mediaType: string;
}

/** Shows a screenshot to a model that sees pictures and returns its answer and what it cost. */
export function askAboutPicture(vision: Vision, png: Buffer, question: string, signal?: AbortSignal): Promise<{ text: string; costUsd: number }> {
  return askAboutPictures(
    vision,
    [{ data: png, mediaType: "image/png" }],
    `This is a screenshot of a page. ${question}\nAnswer briefly and concretely, in the language of the question.`,
    signal,
  );
}

/** Shows several pictures at once (a page on a desktop and a phone, say) with one question. */
export async function askAboutPictures(vision: Vision, pictures: Picture[], prompt: string, signal?: AbortSignal): Promise<{ text: string; costUsd: number }> {
  // Streamed like every other answer in Drimvox; the text is collected.
  const result = streamText({
    model: languageModel(vision.conn, vision.model),
    maxRetries: 1,
    abortSignal: signal,
    onError: () => {},
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }, ...pictures.map((p) => ({ type: "file" as const, data: p.data, mediaType: p.mediaType }))],
      },
    ],
  });
  const text = await result.text;
  const usage = await result.usage;
  const p = vision.price;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const costUsd = p?.priceIn != null && p.priceOut != null ? Number(((input * p.priceIn + output * p.priceOut) / 1_000_000).toFixed(9)) : 0;
  return { text: text.trim(), costUsd };
}

/**
 * The model for screenshots: the one picked in the settings, else the task's own when it sees pictures.
 * Null when neither is available.
 */
export async function resolveVision(
  setting: { providerId: string; model: string } | null,
  providers: { connection(id: string): Connection | null },
  task: { providerId: string | null; model: string },
  find: (conn: Connection, model: string) => Promise<ModelInfo | undefined>,
): Promise<Vision | null> {
  if (setting) {
    const conn = providers.connection(setting.providerId);
    if (conn) return { conn, model: setting.model, price: await find(conn, setting.model) };
  }
  const conn = task.providerId ? providers.connection(task.providerId) : null;
  if (!conn) return null;
  const info = await find(conn, task.model);
  return info?.vision ? { conn, model: task.model, price: info } : null;
}
