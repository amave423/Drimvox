import type { Page } from "@playwright/test";

/** "+ Project": the folder opens at once as the project's conversation (no kind to choose any more). */
export async function addProject(page: Page): Promise<void> {
  await page.getByRole("button", { name: "+ Проект" }).click();
}
