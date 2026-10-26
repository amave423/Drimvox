import type { Locator, Page } from "@playwright/test";

/** The sidebar's way into the parameters (the chat box has an options button of the same name). */
export const paramsButton = (page: Page): Locator => page.locator(".side-nav").getByRole("button", { name: "Параметры", exact: true });

/** Opens a section of the parameters: through "Параметры" in the sidebar, or beside the page when already there. */
export async function openSection(page: Page, name: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Разделы параметров" });
  if (!(await nav.isVisible())) await paramsButton(page).click();
  await nav.getByRole("button", { name, exact: true }).click();
}

/** Starts a new chat from the sidebar, leaving the parameters first: their page has no sidebar. */
export async function newChat(page: Page): Promise<void> {
  if (await page.getByRole("navigation", { name: "Разделы параметров" }).isVisible()) await page.getByRole("button", { name: "Назад" }).click();
  await page.getByRole("button", { name: "+ Новый чат" }).click();
}
