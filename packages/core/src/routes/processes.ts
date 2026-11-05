import { zValidator } from "@hono/zod-validator";
import { processStopSchema, type ProcessOwner, type ProcessView } from "@drimvox/shared";
import { Hono } from "hono";
import type { Background } from "../agent/background";

export interface ProcessNames {
  /** The project whose agent's conversation this is, if any. */
  projectOfChat(chatId: string): { id: string; name: string } | null;
  project(projectId: string): { name: string } | null;
  chat(chatId: string): { title: string | null } | null;
  task(taskId: string): { title: string } | null;
}

/**
 * What runs in the background, of every agent and every started result (asked for: to see what runs and stop what is
 * not needed; seen live: two servers on one port).
 */
export function processRoutes(background: Background, names: ProcessNames) {
  const ownerOf = (key: string): ProcessOwner => {
    if (key.startsWith("site:")) {
      const projectId = key.slice("site:".length);
      return { kind: "site", projectId, name: names.project(projectId)?.name ?? projectId };
    }
    const project = names.projectOfChat(key);
    if (project) return { kind: "project", projectId: project.id, name: project.name };
    const chat = names.chat(key);
    if (chat) return { kind: "chat", chatId: key, name: chat.title ?? "" };
    const task = names.task(key);
    if (task) return { kind: "task", taskId: key, name: task.title };
    return { kind: "other", name: key };
  };
  return new Hono()
    .get("/", (c) => c.json(background.running().map((p): ProcessView => ({ ...p, owner: ownerOf(p.key) })), 200))
    .post("/stop", zValidator("json", processStopSchema), (c) => {
      const { key, id } = c.req.valid("json");
      return background.stop(key, id) ? c.json({ stopped: true }, 200) : c.json({ error: { code: "not_found" as const } }, 404);
    });
}
