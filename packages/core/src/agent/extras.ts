import type { WebAccess } from "../internet/web";
import { imageToolsFor } from "../media/agent-tool";
import type { MediaRepo } from "../media/repo";
import type { McpHub } from "../mcp/hub";
import { findModel, listModels } from "../providers/catalog";
import type { ProviderRepo } from "../providers/repo";
import { resolveVision } from "../visual/look";
import type { VisualKit } from "../visual/tools";
import type { ApprovalAnswer } from "./approvals";
import type { PassContext } from "./pass";

/** The parts of the core an agent reaches beyond its copy: the internet, skills, MCP, pictures, screenshots. */
export interface ExtrasOptions {
  providers: ProviderRepo;
  media: MediaRepo;
  web: WebAccess;
  mcp: McpHub;
  visualKit: VisualKit;
  skillsDir: string;
  imageModel(): { providerId: string; model: string } | null;
  visionModel(): { providerId: string; model: string } | null;
}

type Extras = Pick<PassContext, "web" | "skillsDir" | "visualKit" | "vision" | "mcpTools" | "imageTools">;

/** One task's share of them; `ask` puts a permission request in front of the user. */
export function taskExtras(o: ExtrasOptions, taskId: string, ask: (command: string, signal?: AbortSignal) => Promise<ApprovalAnswer>): Extras {
  return {
    web: o.web,
    skillsDir: o.skillsDir,
    visualKit: o.visualKit,
    vision: (row) => resolveVision(o.visionModel(), o.providers, { providerId: row.provider_id, model: row.model }, findModel, listModels),
    mcpTools: (hooks) => o.mcp.toolsFor((call) => ask(`${call.server}: ${call.tool} ${JSON.stringify(call.input).slice(0, 500)}`, call.signal), hooks),
    imageTools: (row, hooks, onSpend, budgetLeft) =>
      imageToolsFor(o.imageModel(), o.providers, { worktree: row.worktree, taskId, media: o.media, hooks, budgetLeft, onSpend }),
  };
}
