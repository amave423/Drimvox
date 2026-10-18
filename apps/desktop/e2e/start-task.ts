import { expect, type Page } from "@playwright/test";

interface Start {
  task: string;
  model: string;
  stages?: { interview: boolean; spec: boolean; approveSpec: boolean; testsFirst: boolean };
  team?: { model: string };
}

const DIRECT = { interview: false, spec: false, approveSpec: false, testsFirst: false };

/**
 * Starts a task in the last added project through the core's API, as the window itself would, and opens it. The project
 * page offers the task list now (docs/specs/backlog-loop.md); these tests cover what happens inside a task.
 */
export async function startTask(page: Page, s: Start): Promise<void> {
  const title = s.task.split("\n")[0]!;
  await page.evaluate(async ({ task, model, stages, team }) => {
    const token = await (window as unknown as { artel: { getToken(): Promise<string> } }).artel.getToken();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const projects = (await (await fetch("/api/projects", { headers })).json()) as { id: string }[];
    const providers = (await (await fetch("/api/providers", { headers })).json()) as { id: string }[];
    const providerId = providers[0]!.id;
    const body = { task, providerId, model, stages, ...(team ? { team: { providerId, model: team.model } } : {}) };
    const res = await fetch(`/api/projects/${projects.at(-1)!.id}/tasks`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`task not started: ${res.status}`);
  }, { task: s.task, model: s.model, stages: s.stages ?? DIRECT, team: s.team });
  // The project page lists its tasks; a reload picks up the new one.
  await page.reload();
  await page.getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
  await expect(page.locator(".task-head h1")).toHaveText(title);
}
