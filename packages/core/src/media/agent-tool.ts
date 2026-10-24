import { estimateCost, needsConfirmation, type MediaModel } from "@drimvox/shared";
import { tool, type ToolSet } from "ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import { Workspace } from "../agent/workspace";
import { describeError } from "../providers/errors";
import type { Connection, ProviderRepo } from "../providers/repo";
import { mediaModel } from "./catalog";
import { generateImage } from "./generate";
import type { MediaRepo } from "./repo";

export interface ImageToolDeps {
  conn: Connection;
  /** With prices loaded. */
  model: MediaModel;
  worktree: string;
  taskId: string;
  media: MediaRepo;
  hooks: Omit<ToolHooks, "onFinish">;
  /** Money the task may still spend. */
  budgetLeft(): number;
  onSpend(costUsd: number): void;
}

/** The picture tool for an agent when the settings name an image model the provider still has; none otherwise. */
export async function imageToolsFor(
  ref: { providerId: string; model: string } | null,
  providers: ProviderRepo,
  d: Omit<ImageToolDeps, "conn" | "model">,
): Promise<ToolSet> {
  const conn = ref ? providers.connection(ref.providerId) : null;
  const model = ref && conn ? await mediaModel(conn, "image", ref.model) : null;
  return conn && model ? imageTools({ ...d, conn, model }) : {};
}

/** An agent's way to draw a picture into its copy of the project, with the same price rules as the chat. */
export function imageTools(d: ImageToolDeps): ToolSet {
  const ws = new Workspace(d.worktree);
  return {
    generate_image: tool({
      description:
        "Draw a picture with an image model and save it into the project, for example an icon, a background or an illustration. " +
        "Describe the picture in detail in English. The file type follows the model's output (usually PNG).",
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000),
        path: z.string().min(1).describe("Where to save it in the project, such as assets/hero.png"),
        aspect_ratio: z.string().max(20).optional().describe("Such as 1:1 or 16:9"),
      }),
      execute: async ({ prompt, path, aspect_ratio }, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
        d.hooks.onCall({ callId: options.toolCallId, name: "generate_image", input: { prompt, path, aspect_ratio } });
        const done = (ok: boolean, output: string) => {
          d.hooks.onResult({ callId: options.toolCallId, name: "generate_image", ok, output });
          return output;
        };
        let target: string;
        try {
          target = ws.resolve(path);
        } catch (err) {
          return done(false, `Error: ${err instanceof Error ? err.message : String(err)}`);
        }

        const estimate = estimateCost(d.model, { aspectRatio: aspect_ratio });
        if (estimate !== null && estimate > d.budgetLeft()) return done(false, "Error: the task's budget does not cover this picture.");
        if (needsConfirmation(d.model, estimate)) {
          const price = estimate === null ? "price unknown" : `≈$${estimate.toFixed(2)}`;
          const allowed = await d.hooks.askApproval(`${d.model.id} (${price}): ${prompt}`, "media_cost", options.abortSignal);
          if (!allowed) return done(false, "The user did not allow this picture. Do without it or use a placeholder.");
        }

        try {
          const picture = await generateImage(d.conn, d.model, prompt, { aspectRatio: aspect_ratio }, options.abortSignal);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, picture.bytes);
          const cost = picture.costUsd ?? estimate ?? 0;
          d.onSpend(cost);
          const saved = relative(d.worktree, target).split("\\").join("/");
          d.media.add({ kind: "image", ...picture, costUsd: cost, prompt, providerId: d.conn.id, model: d.model.id, taskId: d.taskId, path: saved });
          return done(true, `Saved ${saved} (${picture.mime}, ${picture.bytes.length} bytes, $${cost.toFixed(4)}).`);
        } catch (err) {
          const e = describeError(err);
          return done(false, `Error: ${e.code}${e.detail ? `: ${e.detail}` : ""}`);
        }
      },
    }),
  };
}
