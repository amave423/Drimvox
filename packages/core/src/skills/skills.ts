import type { SkillView } from "@artel/shared";
import { tool, type ToolSet } from "ai";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";

/**
 * A skill is a folder with SKILL.md: `name` and `description` in the front matter, then instructions,
 * and any files next to it. The same format as Claude Code, so existing skills work as they are.
 */
export interface Skill {
  name: string;
  description: string;
  scope: "shared" | "project";
  /** The skill's folder on disk. */
  dir: string;
}

/** Folders of a project that hold its skills, relative to the project. */
export const PROJECT_SKILL_DIRS = [".artel/skills", ".claude/skills"];

export function parseSkill(text: string, folderName: string): { name: string; description: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const front = match ? match[1]! : "";
  const body = (match ? match[2]! : text).trim();
  const field = (key: string) => {
    const line = front.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
    return line.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  };
  const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
  return { name: field("name") || folderName, description: field("description") || firstLine, body };
}

/** Skills in the given folders, the first of a name winning; folders that do not exist are skipped. */
export function findSkills(roots: { dir: string; scope: Skill["scope"] }[]): Skill[] {
  const found = new Map<string, Skill>();
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root.dir, entry.name);
      const file = join(dir, "SKILL.md");
      if (!existsSync(file)) continue;
      const { name, description } = parseSkill(readFileSync(file, "utf8"), entry.name);
      if (!found.has(name)) found.set(name, { name, description, scope: root.scope, dir });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function projectSkillRoots(projectDir: string): { dir: string; scope: "project" }[] {
  return PROJECT_SKILL_DIRS.map((d) => ({ dir: join(projectDir, d), scope: "project" as const }));
}

export function toSkillView(skill: Skill, projectDir?: string): SkillView {
  const path = skill.scope === "project" && projectDir ? relative(projectDir, skill.dir).split(sep).join("/") : skill.dir;
  return { name: skill.name, description: skill.description, scope: skill.scope, path };
}

/** What an agent is told: the skills there are, by name and description. */
export function skillsInstructions(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "Skills: ready instructions for kinds of work. When one fits the task, call use_skill with its name before you start, and follow it.",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

const MAX_FILES = 50;

/** use_skill opens a skill; read_skill_file reads a file of a shared skill (project skills are in the copy). */
export function skillTools(skills: Skill[], worktree: string, hooks: Omit<ToolHooks, "onFinish" | "askApproval">): ToolSet {
  if (skills.length === 0) return {};
  const byName = new Map(skills.map((s) => [s.name, s]));
  const run = (callId: string, name: string, input: unknown, work: () => string) => {
    hooks.onCall({ callId, name, input });
    let ok = true;
    let output: string;
    try {
      output = work();
    } catch (err) {
      ok = false;
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    hooks.onResult({ callId, name, ok, output: output.slice(0, 4000) });
    return output;
  };
  const skillOf = (name: string) => {
    const skill = byName.get(name);
    if (!skill) throw new Error(`No skill named ${name}. Skills: ${[...byName.keys()].join(", ")}`);
    return skill;
  };

  return {
    use_skill: tool({
      description: "Open a skill: its instructions and the list of its files.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }, o: { toolCallId: string }) =>
        run(o.toolCallId, "use_skill", { name }, () => {
          const skill = skillOf(name);
          const { body } = parseSkill(readFileSync(join(skill.dir, "SKILL.md"), "utf8"), name);
          const files = listFiles(skill.dir).filter((f) => f !== "SKILL.md");
          const where =
            skill.scope === "project"
              ? `Its files are in the project at ${relative(worktree, skill.dir).split(sep).join("/") || "."}; read them with read_file.`
              : "Read its files with read_skill_file.";
          return [body, "", files.length ? `Files of this skill: ${files.join(", ")}. ${where}` : ""].join("\n").trim();
        }),
    }),
    read_skill_file: tool({
      description: "Read a file that belongs to a skill, such as a template or an example.",
      inputSchema: z.object({ name: z.string().min(1), path: z.string().min(1) }),
      execute: async ({ name, path }, o: { toolCallId: string }) =>
        run(o.toolCallId, "read_skill_file", { name, path }, () => {
          const skill = skillOf(name);
          const target = resolve(skill.dir, path);
          if (target !== skill.dir && !target.startsWith(skill.dir + sep)) throw new Error("The path leaves the skill's folder");
          if (statSync(target).size > 500_000) throw new Error("The file is too large to read");
          return readFileSync(target, "utf8");
        }),
    }),
  };
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.slice(0, MAX_FILES);
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya",
};

/** A folder name for a skill: Latin letters, digits and dashes. */
export function skillSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .split("")
      .map((ch) => TRANSLIT[ch] ?? ch)
      .join("")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}
