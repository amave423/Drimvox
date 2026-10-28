import type { McpServerView, SkillView, McpTrust } from "@drimvox/shared";
import { siAnthropic, siFigma, siGithub, siGooglechrome, siNotion, siShadcnui, siSupabase, siUpstash } from "simple-icons";

/** What the card is about: the catalog's filter. */
export type CatalogCategory = "web" | "code" | "design" | "docs";

/** A mark for the card: a vendor's logo from Simple Icons (CC0), or a plain glyph of Drimvox's own. */
export interface CatalogLogo {
  path: string;
  /** A glyph drawn with strokes rather than filled. */
  stroke?: boolean;
}

/** A secret the user gives before a server can work: an environment variable, or a header with a prefix. */
export interface CatalogSecret {
  env?: string;
  header?: { name: string; prefix: string };
  helpUrl: string;
}

interface Base {
  id: string;
  /** A vendor's or a project's name, shown as is; otherwise the texts come from catalog.<id>.name. */
  name?: string;
  /** Who makes it. */
  vendor: string;
  category: CatalogCategory;
  logo: CatalogLogo;
  link: string;
  license: string;
}

/** A ready MCP server: what Drimvox creates when the card is switched on (docs/specs/catalog.md). */
export interface McpEntry extends Base {
  kind: "mcp";
  server: { command?: string; args?: string[]; url?: string };
  secret?: CatalogSecret;
  /** How much it is trusted when switched on, unless the user picks otherwise; "changes" when not said. */
  trust?: McpTrust;
  /** Whether a server the user already has is this one. */
  matches(s: McpServerView): boolean;
}

/** A ready skill: a folder of its authors' GitHub repository, or one of Drimvox's own. */
export interface SkillEntry extends Base {
  kind: "skill";
  /** The skill's name in SKILL.md, which is also how Drimvox knows it is installed. */
  skill: string;
  source: { kind: "github"; repo: string; path: string; ref: string } | { kind: "builtin"; id: "docx" | "xlsx" | "pptx" | "pdf" };
}

export type CatalogEntry = McpEntry | SkillEntry;

const hasArg = (s: McpServerView, part: string) => [s.command ?? "", ...s.args].some((a) => a.includes(part));
const npx = (pkg: string, ...rest: string[]) => ({ command: "npx", args: ["-y", pkg, ...rest] });
const anthropic = (path: string): SkillEntry["source"] => ({ kind: "github", repo: "anthropics/skills", path: `skills/${path}`, ref: "main" });
const superpowers = (path: string): SkillEntry["source"] => ({ kind: "github", repo: "obra/superpowers", path: `skills/${path}`, ref: "main" });

/** Plain glyphs for those without a logo in Simple Icons: drawn with strokes on a 24-unit square. */
const glyph = {
  browser: "M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01M12 13l3 2-3 2",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 21 21",
  flame: "M12 3c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8z",
  memory: "M8 4h8v4H8zM4 10h16v4H4zM8 16h8v4H8zM12 8v2M12 14v2",
  steps: "M4 18h5v-4h5v-4h6M4 18v2M20 6l0 4M17 7l3-3 3 3",
  sparkles: "M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z",
  test: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M8 14h8",
  bug: "M8 8a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM12 10v8M4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z",
  plan: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  check: "M4 12l5 5L20 6",
  doc: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  slides: "M3 4h18v12H3zM12 16v4M8 20h8M7 12l3-3 2 2 4-4",
  pdf: "M6 3h8l4 4v14H6zM14 3v4h4M8.5 15.5h2a1.5 1.5 0 0 0 0-3h-2v5",
  art: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-.5-.3-.9-.3-1.4 0-.8.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5zM7.5 11h.01M10 7h.01M14.5 7h.01",
  palette: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  canvas: "M4 4h16v13H4zM4 14l4-4 3 3 3-3 6 6M8 20h8",
  tool: "M14 7a4 4 0 0 0-5.5 5.2L3 17.7 6.3 21l5.5-5.5A4 4 0 0 0 17 10l-2.5 2.5-2.9-.6-.6-2.9z",
};
const drawn = (path: string): CatalogLogo => ({ path, stroke: true });
const brand = (icon: { path: string }): CatalogLogo => ({ path: icon.path });

export const CATALOG: CatalogEntry[] = [
  // Servers: what they open to the model.
  { kind: "mcp", id: "playwright", name: "Playwright", vendor: "Microsoft", category: "web", logo: drawn(glyph.browser), link: "https://github.com/microsoft/playwright-mcp", license: "Apache-2.0", server: npx("@playwright/mcp@latest", "--headless"), trust: "trusted", matches: (s) => hasArg(s, "@playwright/mcp") },
  { kind: "mcp", id: "chrome-devtools", name: "Chrome DevTools", vendor: "Google", category: "web", logo: brand(siGooglechrome), link: "https://github.com/ChromeDevTools/chrome-devtools-mcp", license: "Apache-2.0", server: npx("chrome-devtools-mcp@latest", "--no-usage-statistics", "--headless"), matches: (s) => hasArg(s, "chrome-devtools-mcp") },
  { kind: "mcp", id: "exa", name: "Exa", vendor: "Exa Labs", category: "web", logo: drawn(glyph.search), link: "https://github.com/exa-labs/exa-mcp-server", license: "MIT", server: { url: "https://mcp.exa.ai/mcp" }, matches: (s) => (s.url ?? "").includes("mcp.exa.ai") },
  { kind: "mcp", id: "firecrawl", name: "Firecrawl", vendor: "Mendable", category: "web", logo: drawn(glyph.flame), link: "https://github.com/firecrawl/firecrawl-mcp-server", license: "MIT", server: npx("firecrawl-mcp"), secret: { env: "FIRECRAWL_API_KEY", helpUrl: "https://www.firecrawl.dev/app/api-keys" }, matches: (s) => hasArg(s, "firecrawl-mcp") },
  { kind: "mcp", id: "context7", name: "Context7", vendor: "Upstash", category: "code", logo: brand(siUpstash), link: "https://github.com/upstash/context7", license: "MIT", server: npx("@upstash/context7-mcp@latest"), matches: (s) => hasArg(s, "context7") },
  { kind: "mcp", id: "github", name: "GitHub", vendor: "GitHub", category: "code", logo: brand(siGithub), link: "https://github.com/github/github-mcp-server", license: "MIT", server: { url: "https://api.githubcopilot.com/mcp/" }, secret: { header: { name: "Authorization", prefix: "Bearer " }, helpUrl: "https://github.com/settings/personal-access-tokens/new" }, matches: (s) => (s.url ?? "").includes("githubcopilot.com/mcp") },
  { kind: "mcp", id: "supabase", name: "Supabase", vendor: "Supabase", category: "code", logo: brand(siSupabase), link: "https://github.com/supabase-community/supabase-mcp", license: "Apache-2.0", server: npx("@supabase/mcp-server-supabase@latest"), secret: { env: "SUPABASE_ACCESS_TOKEN", helpUrl: "https://supabase.com/dashboard/account/tokens" }, matches: (s) => hasArg(s, "mcp-server-supabase") },
  { kind: "mcp", id: "memory", vendor: "Model Context Protocol", category: "code", logo: drawn(glyph.memory), link: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory", license: "MIT", server: npx("@modelcontextprotocol/server-memory"), matches: (s) => hasArg(s, "server-memory") },
  { kind: "mcp", id: "sequential-thinking", vendor: "Model Context Protocol", category: "code", logo: drawn(glyph.steps), link: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking", license: "MIT", server: npx("@modelcontextprotocol/server-sequential-thinking"), matches: (s) => hasArg(s, "server-sequential-thinking") },
  { kind: "mcp", id: "shadcn", name: "shadcn/ui", vendor: "shadcn", category: "design", logo: brand(siShadcnui), link: "https://ui.shadcn.com/docs/mcp", license: "MIT", server: npx("shadcn@latest", "mcp"), matches: (s) => s.args.includes("mcp") && hasArg(s, "shadcn") },
  { kind: "mcp", id: "magic", name: "21st.dev Magic", vendor: "21st.dev", category: "design", logo: drawn(glyph.sparkles), link: "https://github.com/21st-dev/magic-mcp", license: "ISC", server: npx("@21st-dev/magic@latest"), secret: { env: "API_KEY_21ST", helpUrl: "https://21st.dev/mcp" }, matches: (s) => hasArg(s, "@21st-dev/magic") },
  { kind: "mcp", id: "figma", name: "Figma", vendor: "Framelink", category: "design", logo: brand(siFigma), link: "https://github.com/GLips/Figma-Context-MCP", license: "MIT", server: npx("figma-developer-mcp", "--stdio"), secret: { env: "FIGMA_API_KEY", helpUrl: "https://www.figma.com/developers/api#access-tokens" }, matches: (s) => hasArg(s, "figma-developer-mcp") },
  { kind: "mcp", id: "notion", name: "Notion", vendor: "Notion", category: "docs", logo: brand(siNotion), link: "https://github.com/makenotion/notion-mcp-server", license: "MIT", server: npx("@notionhq/notion-mcp-server"), secret: { env: "NOTION_TOKEN", helpUrl: "https://www.notion.so/profile/integrations" }, matches: (s) => hasArg(s, "notion-mcp-server") },

  // Skills: instructions a model opens when the task fits.
  { kind: "skill", id: "frontend-design", vendor: "Anthropic", category: "design", logo: brand(siAnthropic), link: "https://github.com/anthropics/skills/tree/main/skills/frontend-design", license: "Apache-2.0", skill: "frontend-design", source: anthropic("frontend-design") },
  { kind: "skill", id: "canvas-design", vendor: "Anthropic", category: "design", logo: drawn(glyph.canvas), link: "https://github.com/anthropics/skills/tree/main/skills/canvas-design", license: "Apache-2.0", skill: "canvas-design", source: anthropic("canvas-design") },
  { kind: "skill", id: "theme-factory", vendor: "Anthropic", category: "design", logo: drawn(glyph.palette), link: "https://github.com/anthropics/skills/tree/main/skills/theme-factory", license: "Apache-2.0", skill: "theme-factory", source: anthropic("theme-factory") },
  { kind: "skill", id: "algorithmic-art", vendor: "Anthropic", category: "design", logo: drawn(glyph.art), link: "https://github.com/anthropics/skills/tree/main/skills/algorithmic-art", license: "Apache-2.0", skill: "algorithmic-art", source: anthropic("algorithmic-art") },
  { kind: "skill", id: "webapp-testing", vendor: "Anthropic", category: "web", logo: drawn(glyph.test), link: "https://github.com/anthropics/skills/tree/main/skills/webapp-testing", license: "Apache-2.0", skill: "webapp-testing", source: anthropic("webapp-testing") },
  { kind: "skill", id: "mcp-builder", vendor: "Anthropic", category: "code", logo: drawn(glyph.tool), link: "https://github.com/anthropics/skills/tree/main/skills/mcp-builder", license: "Apache-2.0", skill: "mcp-builder", source: anthropic("mcp-builder") },
  { kind: "skill", id: "skill-creator", vendor: "Anthropic", category: "code", logo: drawn(glyph.sparkles), link: "https://github.com/anthropics/skills/tree/main/skills/skill-creator", license: "Apache-2.0", skill: "skill-creator", source: anthropic("skill-creator") },
  { kind: "skill", id: "tdd", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.check), link: "https://github.com/obra/superpowers/tree/main/skills/test-driven-development", license: "MIT", skill: "test-driven-development", source: superpowers("test-driven-development") },
  { kind: "skill", id: "debugging", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.bug), link: "https://github.com/obra/superpowers/tree/main/skills/systematic-debugging", license: "MIT", skill: "systematic-debugging", source: superpowers("systematic-debugging") },
  { kind: "skill", id: "brainstorming", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.bulb), link: "https://github.com/obra/superpowers/tree/main/skills/brainstorming", license: "MIT", skill: "brainstorming", source: superpowers("brainstorming") },
  { kind: "skill", id: "writing-plans", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.plan), link: "https://github.com/obra/superpowers/tree/main/skills/writing-plans", license: "MIT", skill: "writing-plans", source: superpowers("writing-plans") },
  { kind: "skill", id: "verification", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.check), link: "https://github.com/obra/superpowers/tree/main/skills/verification-before-completion", license: "MIT", skill: "verification-before-completion", source: superpowers("verification-before-completion") },
  { kind: "skill", id: "docx", vendor: "Drimvox", category: "docs", logo: drawn(glyph.doc), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "docx", source: { kind: "builtin", id: "docx" } },
  { kind: "skill", id: "xlsx", vendor: "Drimvox", category: "docs", logo: drawn(glyph.table), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "xlsx", source: { kind: "builtin", id: "xlsx" } },
  { kind: "skill", id: "pptx", vendor: "Drimvox", category: "docs", logo: drawn(glyph.slides), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "pptx", source: { kind: "builtin", id: "pptx" } },
  { kind: "skill", id: "pdf", vendor: "Drimvox", category: "docs", logo: drawn(glyph.pdf), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "pdf", source: { kind: "builtin", id: "pdf" } },
];

/** The user's own server or skill that a card stands for, if any. */
/**
 * A server or a skill switched on from the catalog: its card manages it, so the list of servers and skills added by hand
 * leaves it out (asked for).
 */
export function fromCatalog(item: McpServerView | SkillView): boolean {
  return "scope" in item
    ? item.scope === "shared" && CATALOG.some((e) => e.kind === "skill" && e.skill === item.name)
    : CATALOG.some((e) => e.kind === "mcp" && e.matches(item));
}

export function installed(entry: CatalogEntry, servers: McpServerView[], skills: SkillView[]): McpServerView | SkillView | null {
  return entry.kind === "mcp" ? (servers.find((s) => entry.matches(s)) ?? null) : (skills.find((s) => s.scope === "shared" && s.name === entry.skill) ?? null);
}
