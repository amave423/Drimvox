import type { McpServerView, SkillView } from "@drimvox/shared";
import type { MessageKey } from "../i18n";

/** A ready MCP server: what Drimvox creates when the card is switched on (docs/specs/catalog.md). */
export interface McpEntry {
  kind: "mcp";
  id: string;
  name: string;
  /** What the card and the details say, in the interface's language. */
  about: MessageKey;
  details: MessageKey;
  link: string;
  server: { command?: string; args?: string[]; url?: string };
  /** A secret the user gives before it can work: sent as this header, with this prefix. */
  secret?: { header: string; prefix: string; label: MessageKey; help: MessageKey; helpUrl: string };
  /** Whether a server the user already has is this one. */
  matches(s: McpServerView): boolean;
}

/** A ready skill: instructions Drimvox writes into the shared skills when the card is switched on. */
export interface SkillEntry {
  kind: "skill";
  id: string;
  name: MessageKey;
  about: MessageKey;
  details: MessageKey;
  /** The skill's folder name, which is also how Drimvox knows it is there. */
  slug: string;
  description: string;
  instructions: string;
}

export type CatalogEntry = McpEntry | SkillEntry;

const hasArg = (s: McpServerView, part: string) => [s.command ?? "", ...s.args].some((a) => a.includes(part));

const DOCUMENTS = `# Office documents and PDF

Make and edit documents with libraries, never by driving Word, Excel or PowerPoint (no COM, no -ComObject: hidden
Office windows wait for answers nobody gives).

- Word (.docx): python-docx (Python) or docx (Node). Use real headings (Heading 1/2), lists and tables, not spaces and
  tabs; set the page size and margins; put pictures with their width in centimetres.
- Excel (.xlsx): openpyxl (Python) or exceljs (Node). Keep data as numbers and dates, not text; write formulas where the
  user will change inputs; format the header row, freeze it, set column widths; one table per sheet.
- PowerPoint (.pptx): python-pptx (Python) or pptxgenjs (Node). One idea per slide, a title on each, large text (at least
  20 pt), pictures instead of text walls; use the layouts of a template when the user gives one.
- PDF: read with pypdf or pdfplumber; make one from HTML (Playwright print to PDF) or with reportlab.

Install the library in the project or a virtual environment first. After writing, open the file again with the same
library and check what is in it (headings, sheets, slides, pages) before saying it is done. Say where the file is.`;

const DESIGN = `# Distinctive web design

Use this when making or changing a site's or an app's look.

- Start from the subject and the audience: one clear direction (for example "Chalkboard menu" for a café), named, with
  its idea in a sentence. Avoid the generic look of templates: purple gradients, glass cards, centred hero with two
  buttons, emoji icons.
- Type: two fonts at most, chosen for the direction (Google Fonts); a clear scale (for example 14/16/20/28/40); body
  text 16 px or more, lines 60–75 characters, line height 1.5.
- Colour: a small palette as CSS variables (background, text, muted, accent, line), contrast at least 4.5:1 for text;
  one accent used sparingly; a dark theme only when asked or when it fits.
- Layout: a grid with consistent spacing steps (4/8/16/24/40); generous whitespace; align to edges; real content and
  pictures instead of lorem ipsum.
- Detail: one signature element that carries the direction (a texture, a hand-drawn line, an unusual frame), states for
  hover, focus and pressed, smooth but short motion (150–250 ms).
- Phones first: check 390 px wide and a desktop width; no horizontal scrolling; tap targets 44 px.
- Look at the result (screenshots) on both widths and fix what looks off before saying it is done.`;

export const CATALOG: CatalogEntry[] = [
  {
    kind: "mcp",
    id: "playwright",
    name: "Playwright",
    about: "catalog.playwright.about",
    details: "catalog.playwright.details",
    link: "https://github.com/microsoft/playwright-mcp",
    server: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    matches: (s) => hasArg(s, "@playwright/mcp"),
  },
  {
    kind: "mcp",
    id: "context7",
    name: "Context7",
    about: "catalog.context7.about",
    details: "catalog.context7.details",
    link: "https://github.com/upstash/context7",
    server: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] },
    matches: (s) => hasArg(s, "context7"),
  },
  {
    kind: "mcp",
    id: "github",
    name: "GitHub",
    about: "catalog.github.about",
    details: "catalog.github.details",
    link: "https://github.com/github/github-mcp-server",
    server: { url: "https://api.githubcopilot.com/mcp/" },
    secret: {
      header: "Authorization",
      prefix: "Bearer ",
      label: "catalog.github.token",
      help: "catalog.github.tokenHelp",
      helpUrl: "https://github.com/settings/personal-access-tokens/new",
    },
    matches: (s) => (s.url ?? "").includes("githubcopilot.com/mcp"),
  },
  {
    kind: "skill",
    id: "documents",
    name: "catalog.documents.name",
    about: "catalog.documents.about",
    details: "catalog.documents.details",
    slug: "documents",
    description: "When the user wants a Word, Excel, PowerPoint or PDF file made, filled or read",
    instructions: DOCUMENTS,
  },
  {
    kind: "skill",
    id: "web-design",
    name: "catalog.design.name",
    about: "catalog.design.about",
    details: "catalog.design.details",
    slug: "web-design",
    description: "When making or changing the look of a site or an app's interface",
    instructions: DESIGN,
  },
];

/** The user's own server or skill that a card stands for, if any. */
export function installed(entry: CatalogEntry, servers: McpServerView[], skills: SkillView[]): McpServerView | SkillView | null {
  return entry.kind === "mcp" ? (servers.find((s) => entry.matches(s)) ?? null) : (skills.find((s) => s.scope === "shared" && s.name === entry.slug) ?? null);
}
