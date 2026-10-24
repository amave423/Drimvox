// Tools part of the live check (`--tools`): one real agent task that opens a skill, calls an MCP tool and looks at a page.
import type { TaskEvent, TaskView } from "@drimvox/shared";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

// From the project folder: the live check runs as a bundle in a temporary folder.
const MCP_SERVER = join(process.cwd(), "packages", "core", "test", "mcp-server.mjs");
const PAGE = "https://wttr.in/Moscow";

const TASK =
  "Это проверка инструментов, в проекте ничего не меняй. По шагам: 1) открой скилл report-style; " +
  "2) сложи 2 и 3 инструментом MCP-сервера demo; 3) посмотри на страницу " +
  `${PAGE} через look_at_page и спроси, что на ней изображено; 4) вызови finish, итог напиши по правилам скилла.`;

/** A real picture for "screenshots": the live check runs without Electron, so it shows the model wttr.in's weather card. */
export async function weatherCard(): Promise<Buffer> {
  const res = await fetch("https://wttr.in/Moscow_0pq_lang=ru.png", { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`wttr.in answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function checkTools(api: Api, providerId: string, model: string, log: (...p: unknown[]) => void): Promise<boolean> {
  const repo = mkdtempSync(join(tmpdir(), "drimvox-live-tools-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  try {
    writeFileSync(join(repo, "README.md"), "# Tools\n");
    git("init", "-q", "-b", "main");
    git("-c", "user.name=Live", "-c", "user.email=live@example.com", "commit", "-q", "--allow-empty", "-m", "Initial");

    await api("POST", "/skills", { name: "report-style", description: "Как писать итог задачи", instructions: "Начинай итог словами «Готово-готово:», дальше одно предложение." });
    const server = await api("POST", "/mcp", { name: "demo", command: process.execPath, args: [MCP_SERVER] });
    const status = (await api("GET", `/mcp/${server.body.id}/status`)).body;
    log("mcp:", status.ok ? `${status.tools.length} tools` : status.error);

    const project = (await api("POST", "/projects", { path: repo })).body;
    const stages = { interview: false, spec: false, approveSpec: false, testsFirst: false };
    const id = ((await api("POST", `/projects/${project.id}/tasks`, { task: TASK, providerId, model, stages })).body as TaskView).id;

    let task: TaskView | null = null;
    const until = Date.now() + 6 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      task = (await api("GET", `/tasks/${id}`)).body as TaskView;
      // The local test server's tools are allowed; anything else is refused.
      if (task.pendingApproval) await api("POST", `/tasks/${id}/approvals/${task.pendingApproval.id}`, { allow: task.pendingApproval.reason === "mcp" });
      else if (task.status !== "running") break;
    }
    const events = (await api("GET", `/tasks/${id}/events`)).body as TaskEvent[];
    const results = events.filter((e) => e.kind === "tool_result").map((e) => e.data as { name: string; ok: boolean; output: string });
    const used = (name: string) => results.find((r) => r.name === name);
    const skill = used("use_skill");
    const mcp = used("demo/add");
    const look = used("look_at_page");
    log(`tools ${model}:`, {
      status: task?.status,
      costUsd: task ? Number(task.costUsd.toFixed(6)) : null,
      skill: skill?.ok ?? false,
      mcp: mcp?.output ?? null,
      screenshot: events.some((e) => e.kind === "screenshot"),
      look: look?.output.slice(0, 200) ?? null,
      summary: task?.summary,
    });
    return !!skill?.ok && mcp?.output === "5" && !!look?.ok && !!task?.summary?.includes("Готово-готово");
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
