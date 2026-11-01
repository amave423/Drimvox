import type { ToolSet } from "ai";
import { join } from "node:path";
import type { ToolHooks } from "../agent/tools";
import { Workspace } from "../agent/workspace";
import type { BrowserDriver } from "../browser/driver";
import type { Vision } from "../visual/look";
import { auditTools } from "./audit";
import { compareTools } from "./compare";
import { downloadTools } from "./downloads";
import { emailTools } from "./email";
import { sshTools, type SshServers } from "./ssh";

export interface ToolboxDeps {
  dataDir: string;
  ssh: SshServers;
  /** The agent's browser, where there is one: before and after of its page. */
  browser: BrowserDriver | null;
}

/**
 * Tools beyond files and the web (docs/specs/tools.md, asked for): downloads and the text on pictures, a temporary inbox,
 * other computers over SSH, the dependencies' vulnerabilities, before and after of a page. A chat with a folder and a
 * project's run have them; a plain chat keeps only the web.
 */
export function toolbox(
  d: ToolboxDeps,
  o: { folder: string | null; vision: Vision | null; hooks: Pick<ToolHooks, "onCall" | "askApproval">; see?: (png: Buffer, question: string, signal?: AbortSignal) => Promise<string> },
): ToolSet {
  const ws = o.folder ? new Workspace(o.folder) : null;
  return {
    ...downloadTools(d.dataDir, ws, o.vision, o.hooks),
    ...emailTools(o.hooks),
    ...sshTools(d.ssh, ws, o.hooks),
    ...(o.folder ? auditTools(o.folder, o.hooks) : {}),
    ...(d.browser?.available() ? compareTools(d.browser, join(d.dataDir, "snapshots"), o.hooks, o.see) : {}),
  };
}
