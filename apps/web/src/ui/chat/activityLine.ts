import type { MessageKey } from "../../i18n";

/** Tools with their own line in an answer: a chat with a folder, and a project's run (docs/specs/project-work.md). */
const OWN_LINES = [
  "list_files",
  "read_file",
  "search",
  "write_file",
  "edit_file",
  "run_command",
  "update_notes",
  "save_attachment",
  "update_checklist",
  "ask_user",
  "finish_work",
  "look_at_page",
  "start_background",
  "read_background",
  "stop_background",
  "use_skill",
  "browse_page",
  "open_for_user",
  "browser_open",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_choose",
  "browser_press",
  "browser_scroll",
  "browser_back",
  "browser_tab",
  "browser_ask_user",
  "make_picture",
  "make_clip",
  "look_at_image",
  "design_review",
];

/** One line of what the model did: "Reads app.js", "Searches the web: …". */
export function activityLine(t: (key: MessageKey, vars?: Record<string, string | number>) => string, name: string, input: string): string {
  if (name === "web_search") return t("web.searching", { query: input });
  if (name === "open_page") return t("web.reading", { url: input });
  // The folder itself is "." to the model; to the reader it is just "the folder" (seen: "Looks at the folder .").
  if (OWN_LINES.includes(name)) return t(`folder.tool.${name}` as MessageKey, { input: input === "." || input === "./" ? "" : input }).trim();
  return t("chat.mcpCall", { name });
}
