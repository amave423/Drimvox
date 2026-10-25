import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { removeTree } from "../fsx";
import { BUILTIN } from "./builtin/index";
import { parseSkill, skillSlug } from "./skills";

/** Where GitHub's API and its raw files answer: fakes in tests. */
export interface SkillSources {
  api: string;
  raw: string;
}
export const SKILL_SOURCES: SkillSources = { api: "https://api.github.com", raw: "https://raw.githubusercontent.com" };

/** A ready skill is small: a few instructions, scripts and examples. */
const MAX_FILES = 300;
const MAX_BYTES = 20 * 1024 * 1024;

export class SkillInstallError extends Error {
  constructor(readonly code: "not_skill" | "exists" | "too_big" | "download") {
    super(code);
  }
}

type Source = { kind: "github"; repo: string; path: string; ref: string } | { kind: "builtin"; id: keyof typeof BUILTIN };

/** The skill's files: relative path → content. */
async function filesOf(source: Source, urls: SkillSources): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (source.kind === "builtin") {
    files.set("SKILL.md", Buffer.from(BUILTIN[source.id]));
    return files;
  }
  const folder = posix.normalize(source.path).replace(/^\/+|\/+$/g, "");
  if (!folder || folder.startsWith("..") || folder.includes("/../")) throw new SkillInstallError("not_skill");
  const tree = await fetch(`${urls.api}/repos/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Drimvox" },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!tree?.ok) throw new SkillInstallError("download");
  const body = (await tree.json()) as { tree?: { path: string; type: string; size?: number }[] };
  const blobs = (body.tree ?? []).filter((e) => e.type === "blob" && e.path.startsWith(`${folder}/`));
  if (!blobs.some((b) => b.path === `${folder}/SKILL.md`)) throw new SkillInstallError("not_skill");
  if (blobs.length > MAX_FILES || blobs.reduce((n, b) => n + (b.size ?? 0), 0) > MAX_BYTES) throw new SkillInstallError("too_big");
  for (const blob of blobs) {
    const path = blob.path.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${urls.raw}/${source.repo}/${encodeURIComponent(source.ref)}/${path}`, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!res?.ok) throw new SkillInstallError("download");
    files.set(blob.path.slice(folder.length + 1), Buffer.from(await res.arrayBuffer()));
  }
  return files;
}

/**
 * Installs a ready skill into the shared skills (docs/specs/catalog.md): a folder of a GitHub repository, taken whole
 * with its scripts and examples, or one of Drimvox's own. Returns where it went and what SKILL.md says.
 */
export async function installSkill(sharedDir: string, source: Source, urls: SkillSources): Promise<{ dir: string; name: string; description: string }> {
  const files = await filesOf(source, urls);
  const skill = parseSkill(files.get("SKILL.md")!.toString("utf8"), source.kind === "github" ? posix.basename(source.path) : source.id);
  const dir = join(sharedDir, skillSlug(skill.name));
  if (existsSync(dir)) throw new SkillInstallError("exists");
  try {
    for (const [path, content] of files) {
      // Only inside the skill's folder, whatever the names in the repository say.
      if (path.split("/").some((part) => part === ".." || part === "")) continue;
      const target = join(dir, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  } catch (err) {
    removeTree(dir);
    throw err;
  }
  return { dir, name: skill.name, description: skill.description };
}
