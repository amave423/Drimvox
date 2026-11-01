import { builtinSkills, type McpServerView, type SkillView, type McpTrust } from "@drimvox/shared";
import { siAnthropic, siAvaloniaui, siDocker, siDotnet, siFastapi, siFigma, siGithub, siGmail, siGooglesearchconsole, siMarkdown, siModelcontextprotocol, siNextdotjs, siNotion, siOpenjdk, siOwasp, siPostgresql, siSentry, siShadcnui, siSqlite, siStripe, siSupabase, siUpstash } from "simple-icons";

/** What the card is about: the catalog's filter. */
export type CatalogCategory = "web" | "code" | "design" | "docs";

/** A mark for the card: a vendor's logo from Simple Icons (CC0), or a plain glyph of Drimvox's own. */
export interface CatalogLogo {
  path?: string;
  /** A glyph drawn with strokes rather than filled. */
  stroke?: boolean;
  /** A vendor without a logo in Simple Icons: its letters, set as a mark (asked for: the drawn glyphs looked odd). */
  letters?: string;
}

/** A secret the user gives before a server can work: an environment variable, or a header with a prefix. */
export interface CatalogSecret {
  env?: string;
  header?: { name: string; prefix: string };
  helpUrl: string;
  /** What is asked for, when it is not a key or a token (catalog.secret.<id>): a connection string, a file's path. */
  label?: boolean;
  /** Shown as typed (a path), not hidden like a key. */
  plain?: boolean;
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
  source: { kind: "github"; repo: string; path: string; ref: string } | { kind: "builtin"; id: (typeof builtinSkills)[number] };
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
  doc: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  slides: "M3 4h18v12H3zM12 16v4M8 20h8M7 12l3-3 2 2 4-4",
  pdf: "M6 3h8l4 4v14H6zM14 3v4h4M8.5 15.5h2a1.5 1.5 0 0 0 0-3h-2v5",
  access: "M12 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 7l7 1.5L19 7M12 8.5V14M12 14l-3.5 7M12 14l3.5 7",
  art: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-.5-.3-.9-.3-1.4 0-.8.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5zM7.5 11h.01M10 7h.01M14.5 7h.01",
  palette: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  canvas: "M4 4h16v13H4zM4 14l4-4 3 3 3-3 6 6M8 20h8",
  tool: "M14 7a4 4 0 0 0-5.5 5.2L3 17.7 6.3 21l5.5-5.5A4 4 0 0 0 17 10l-2.5 2.5-2.9-.6-.6-2.9z",
  // Marks for the entries that used to borrow another card's glyph; catalog.test.ts keeps every mark unique.
  wand: "M3 21l4-4M12 3l2.5 2.5L19 9l-3.5-3.5L12 3zM12 9l6 6M18 15l3 3",
  gear: "M12 3a9 9 0 0 1 9 9 9 9 0 0 1-1.5 4.9L16 21h-8l-3.5-4.1A9 9 0 0 1 3 12a9 9 0 0 1 9-9zm0 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  cycles: "M12 4a8 8 0 0 0-4 14.9V17a10 10 0 0 1 8 0v-2.1A8 8 0 0 0 12 4zm0 16a8 8 0 0 0 4-14.9V7a10 10 0 0 1-8 0v2.1A8 8 0 0 0 12 20z",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
};
const drawn = (path: string): CatalogLogo => ({ path, stroke: true });
const brand = (icon: { path: string }): CatalogLogo => ({ path: icon.path });
const letters = (text: string): CatalogLogo => ({ letters: text });

export const CATALOG: CatalogEntry[] = [
  // Servers: what they open to the model. Playwright and Chrome DevTools are built into the agent's browser now (asked for).
  { kind: "mcp", id: "exa", name: "Exa", vendor: "Exa Labs", category: "web", logo: letters("Exa"), link: "https://github.com/exa-labs/exa-mcp-server", license: "MIT", server: { url: "https://mcp.exa.ai/mcp" }, matches: (s) => (s.url ?? "").includes("mcp.exa.ai") },
  { kind: "mcp", id: "firecrawl", name: "Firecrawl", vendor: "Mendable", category: "web", logo: letters("FC"), link: "https://github.com/firecrawl/firecrawl-mcp-server", license: "MIT", server: npx("firecrawl-mcp"), secret: { env: "FIRECRAWL_API_KEY", helpUrl: "https://www.firecrawl.dev/app/api-keys" }, matches: (s) => hasArg(s, "firecrawl-mcp") },
  { kind: "mcp", id: "context7", name: "Context7", vendor: "Upstash", category: "code", logo: brand(siUpstash), link: "https://github.com/upstash/context7", license: "MIT", server: npx("@upstash/context7-mcp@latest"), matches: (s) => hasArg(s, "context7") },
  { kind: "mcp", id: "github", name: "GitHub", vendor: "GitHub", category: "code", logo: brand(siGithub), link: "https://github.com/github/github-mcp-server", license: "MIT", server: { url: "https://api.githubcopilot.com/mcp/" }, secret: { header: { name: "Authorization", prefix: "Bearer " }, helpUrl: "https://github.com/settings/personal-access-tokens/new" }, matches: (s) => (s.url ?? "").includes("githubcopilot.com/mcp") },
  { kind: "mcp", id: "postgres", name: "PostgreSQL", vendor: "Model Context Protocol", category: "code", logo: brand(siPostgresql), link: "https://www.npmjs.com/package/@modelcontextprotocol/server-postgres", license: "MIT", server: npx("@modelcontextprotocol/server-postgres", "${DATABASE_URL}"), secret: { env: "DATABASE_URL", helpUrl: "https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING", label: true }, matches: (s) => hasArg(s, "server-postgres") },
  { kind: "mcp", id: "sqlite", name: "SQLite", vendor: "johnnyoshika", category: "code", logo: brand(siSqlite), link: "https://github.com/johnnyoshika/mcp-server-sqlite-npx", license: "MIT", server: npx("mcp-server-sqlite-npx", "${SQLITE_DB}"), secret: { env: "SQLITE_DB", helpUrl: "https://sqlite.org/", label: true, plain: true }, matches: (s) => hasArg(s, "mcp-server-sqlite") },
  { kind: "mcp", id: "sentry", name: "Sentry", vendor: "Sentry", category: "code", logo: brand(siSentry), link: "https://github.com/getsentry/sentry-mcp", license: "Apache-2.0", server: npx("@sentry/mcp-server@latest"), secret: { env: "SENTRY_ACCESS_TOKEN", helpUrl: "https://sentry.io/settings/account/api/auth-tokens/" }, matches: (s) => hasArg(s, "@sentry/mcp-server") },
  { kind: "mcp", id: "stripe", name: "Stripe", vendor: "Stripe", category: "code", logo: brand(siStripe), link: "https://github.com/stripe/agent-toolkit", license: "MIT", server: npx("@stripe/mcp", "--tools=all", "--api-key=${STRIPE_SECRET_KEY}"), secret: { env: "STRIPE_SECRET_KEY", helpUrl: "https://dashboard.stripe.com/apikeys" }, matches: (s) => hasArg(s, "@stripe/mcp") },
  { kind: "mcp", id: "supabase", name: "Supabase", vendor: "Supabase", category: "code", logo: brand(siSupabase), link: "https://github.com/supabase-community/supabase-mcp", license: "Apache-2.0", server: npx("@supabase/mcp-server-supabase@latest"), secret: { env: "SUPABASE_ACCESS_TOKEN", helpUrl: "https://supabase.com/dashboard/account/tokens" }, matches: (s) => hasArg(s, "mcp-server-supabase") },
  { kind: "mcp", id: "memory", vendor: "Model Context Protocol", category: "code", logo: brand(siModelcontextprotocol), link: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory", license: "MIT", server: npx("@modelcontextprotocol/server-memory"), matches: (s) => hasArg(s, "server-memory") },
  { kind: "mcp", id: "sequential-thinking", vendor: "Model Context Protocol", category: "code", logo: letters("1·2·3"), link: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking", license: "MIT", server: npx("@modelcontextprotocol/server-sequential-thinking"), matches: (s) => hasArg(s, "server-sequential-thinking") },
  { kind: "mcp", id: "shadcn", name: "shadcn/ui", vendor: "shadcn", category: "design", logo: brand(siShadcnui), link: "https://ui.shadcn.com/docs/mcp", license: "MIT", server: npx("shadcn@latest", "mcp"), matches: (s) => s.args.includes("mcp") && hasArg(s, "shadcn") },
  { kind: "mcp", id: "magic", name: "21st.dev Magic", vendor: "21st.dev", category: "design", logo: letters("21"), link: "https://github.com/21st-dev/magic-mcp", license: "ISC", server: npx("@21st-dev/magic@latest"), secret: { env: "API_KEY_21ST", helpUrl: "https://21st.dev/mcp" }, matches: (s) => hasArg(s, "@21st-dev/magic") },
  { kind: "mcp", id: "figma", name: "Figma", vendor: "Framelink", category: "design", logo: brand(siFigma), link: "https://github.com/GLips/Figma-Context-MCP", license: "MIT", server: npx("figma-developer-mcp", "--stdio"), secret: { env: "FIGMA_API_KEY", helpUrl: "https://www.figma.com/developers/api#access-tokens" }, matches: (s) => hasArg(s, "figma-developer-mcp") },
  { kind: "mcp", id: "notion", name: "Notion", vendor: "Notion", category: "docs", logo: brand(siNotion), link: "https://github.com/makenotion/notion-mcp-server", license: "MIT", server: npx("@notionhq/notion-mcp-server"), secret: { env: "NOTION_TOKEN", helpUrl: "https://www.notion.so/profile/integrations" }, matches: (s) => hasArg(s, "notion-mcp-server") },

  // Skills: instructions a model opens when the task fits.
  { kind: "skill", id: "frontend-design", vendor: "Anthropic", category: "design", logo: brand(siAnthropic), link: "https://github.com/anthropics/skills/tree/main/skills/frontend-design", license: "Apache-2.0", skill: "frontend-design", source: anthropic("frontend-design") },
  { kind: "skill", id: "canvas-design", vendor: "Anthropic", category: "design", logo: drawn(glyph.canvas), link: "https://github.com/anthropics/skills/tree/main/skills/canvas-design", license: "Apache-2.0", skill: "canvas-design", source: anthropic("canvas-design") },
  { kind: "skill", id: "theme-factory", vendor: "Anthropic", category: "design", logo: drawn(glyph.palette), link: "https://github.com/anthropics/skills/tree/main/skills/theme-factory", license: "Apache-2.0", skill: "theme-factory", source: anthropic("theme-factory") },
  { kind: "skill", id: "algorithmic-art", vendor: "Anthropic", category: "design", logo: drawn(glyph.art), link: "https://github.com/anthropics/skills/tree/main/skills/algorithmic-art", license: "Apache-2.0", skill: "algorithmic-art", source: anthropic("algorithmic-art") },
  { kind: "skill", id: "webapp-testing", vendor: "Anthropic", category: "web", logo: drawn(glyph.test), link: "https://github.com/anthropics/skills/tree/main/skills/webapp-testing", license: "Apache-2.0", skill: "webapp-testing", source: anthropic("webapp-testing") },
  { kind: "skill", id: "mcp-builder", vendor: "Anthropic", category: "code", logo: drawn(glyph.tool), link: "https://github.com/anthropics/skills/tree/main/skills/mcp-builder", license: "Apache-2.0", skill: "mcp-builder", source: anthropic("mcp-builder") },
  { kind: "skill", id: "skill-creator", vendor: "Anthropic", category: "code", logo: drawn(glyph.wand), link: "https://github.com/anthropics/skills/tree/main/skills/skill-creator", license: "Apache-2.0", skill: "skill-creator", source: anthropic("skill-creator") },
  { kind: "skill", id: "tdd", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.cycles), link: "https://github.com/obra/superpowers/tree/main/skills/test-driven-development", license: "MIT", skill: "test-driven-development", source: superpowers("test-driven-development") },
  { kind: "skill", id: "debugging", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.bug), link: "https://github.com/obra/superpowers/tree/main/skills/systematic-debugging", license: "MIT", skill: "systematic-debugging", source: superpowers("systematic-debugging") },
  { kind: "skill", id: "brainstorming", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.bulb), link: "https://github.com/obra/superpowers/tree/main/skills/brainstorming", license: "MIT", skill: "brainstorming", source: superpowers("brainstorming") },
  { kind: "skill", id: "writing-plans", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.plan), link: "https://github.com/obra/superpowers/tree/main/skills/writing-plans", license: "MIT", skill: "writing-plans", source: superpowers("writing-plans") },
  { kind: "skill", id: "verification", vendor: "obra/superpowers", category: "code", logo: drawn(glyph.gear), link: "https://github.com/obra/superpowers/tree/main/skills/verification-before-completion", license: "MIT", skill: "verification-before-completion", source: superpowers("verification-before-completion") },
  { kind: "skill", id: "docx", vendor: "Drimvox", category: "docs", logo: drawn(glyph.doc), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "docx", source: { kind: "builtin", id: "docx" } },
  { kind: "skill", id: "xlsx", vendor: "Drimvox", category: "docs", logo: drawn(glyph.table), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "xlsx", source: { kind: "builtin", id: "xlsx" } },
  { kind: "skill", id: "pptx", vendor: "Drimvox", category: "docs", logo: drawn(glyph.slides), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "pptx", source: { kind: "builtin", id: "pptx" } },
  { kind: "skill", id: "pdf", vendor: "Drimvox", category: "docs", logo: drawn(glyph.pdf), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "pdf", source: { kind: "builtin", id: "pdf" } },
  { kind: "skill", id: "security-review", vendor: "Drimvox", category: "code", logo: brand(siOwasp), link: "https://owasp.org/www-project-top-ten/", license: "MIT", skill: "security-review", source: { kind: "builtin", id: "security-review" } },
  { kind: "skill", id: "seo-performance", vendor: "Drimvox", category: "web", logo: brand(siGooglesearchconsole), link: "https://web.dev/articles/vitals", license: "MIT", skill: "seo-performance", source: { kind: "builtin", id: "seo-performance" } },
  { kind: "skill", id: "accessibility", vendor: "Drimvox", category: "web", logo: drawn(glyph.access), link: "https://www.w3.org/WAI/standards-guidelines/wcag/", license: "MIT", skill: "accessibility", source: { kind: "builtin", id: "accessibility" } },
  { kind: "skill", id: "nextjs", vendor: "Drimvox", category: "code", logo: brand(siNextdotjs), link: "https://nextjs.org/docs", license: "MIT", skill: "nextjs", source: { kind: "builtin", id: "nextjs" } },
  { kind: "skill", id: "fastapi", vendor: "Drimvox", category: "code", logo: brand(siFastapi), link: "https://fastapi.tiangolo.com/", license: "MIT", skill: "fastapi", source: { kind: "builtin", id: "fastapi" } },
  { kind: "skill", id: "docker", vendor: "Drimvox", category: "code", logo: brand(siDocker), link: "https://docs.docker.com/", license: "MIT", skill: "docker", source: { kind: "builtin", id: "docker" } },
  { kind: "skill", id: "project-docs", vendor: "Drimvox", category: "docs", logo: brand(siMarkdown), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "project-docs", source: { kind: "builtin", id: "project-docs" } },
  { kind: "skill", id: "email-html", vendor: "Drimvox", category: "docs", logo: brand(siGmail), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "email-html", source: { kind: "builtin", id: "email-html" } },
  { kind: "skill", id: "dotnet-desktop", vendor: "Drimvox", category: "code", logo: brand(siDotnet), link: "https://learn.microsoft.com/dotnet/desktop/wpf/", license: "MIT", skill: "dotnet-desktop", source: { kind: "builtin", id: "dotnet-desktop" } },
  { kind: "skill", id: "avalonia", vendor: "Drimvox", category: "code", logo: brand(siAvaloniaui), link: "https://docs.avaloniaui.net/", license: "MIT", skill: "avalonia", source: { kind: "builtin", id: "avalonia" } },
  { kind: "skill", id: "java-desktop", vendor: "Drimvox", category: "code", logo: brand(siOpenjdk), link: "https://openjfx.io/", license: "MIT", skill: "java-desktop", source: { kind: "builtin", id: "java-desktop" } },
  { kind: "skill", id: "desktop-installers", vendor: "Drimvox", category: "code", logo: drawn(glyph.box), link: "https://github.com/amave423/Drimvox", license: "MIT", skill: "desktop-installers", source: { kind: "builtin", id: "desktop-installers" } },
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
