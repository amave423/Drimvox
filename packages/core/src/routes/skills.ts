import { zValidator } from "@hono/zod-validator";
import { skillCreateSchema, skillImportSchema, skillInstallSchema } from "@drimvox/shared";
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { copyTree, removeTree } from "../fsx";
import { installSkill, SkillInstallError, type SkillSources } from "../skills/install";
import { findSkills, parseSkill, skillSlug, toSkillView } from "../skills/skills";

const notFound = { error: { code: "not_found" } } as const;

/** Shared skills: in Drimvox's data folder, for every project. */
export function skillRoutes(sharedDir: string, sources: SkillSources) {
  const shared = () => findSkills([{ dir: sharedDir, scope: "shared" }]);
  return new Hono()
    .get("/", (c) => c.json(shared().map((s) => toSkillView(s))))
    .post("/", zValidator("json", skillCreateSchema), (c) => {
      const { name, description, instructions } = c.req.valid("json");
      const slug = skillSlug(name);
      const dir = join(sharedDir, slug);
      if (existsSync(dir)) return c.json({ error: { code: "exists" } }, 409);
      mkdirSync(dir, { recursive: true });
      // One line each: the front matter is read line by line.
      const line = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: ${line(description)}\n---\n\n${instructions.trim()}\n`);
      return c.json(toSkillView({ name: slug, description: description.trim(), scope: "shared", dir }), 201);
    })
    .post("/import", zValidator("json", skillImportSchema), (c) => {
      const from = c.req.valid("json").path;
      const file = join(from, "SKILL.md");
      if (!existsSync(file)) return c.json({ error: { code: "not_skill" } }, 400);
      const parsed = parseSkill(readFileSync(file, "utf8"), basename(from));
      const dir = join(sharedDir, skillSlug(parsed.name));
      if (existsSync(dir)) return c.json({ error: { code: "exists" } }, 409);
      copyTree(from, dir);
      return c.json(toSkillView({ name: parsed.name, description: parsed.description, scope: "shared", dir }), 201);
    })
    // A ready skill from the catalog (docs/specs/catalog.md): a GitHub repository's folder, or one of Drimvox's own.
    .post("/install", zValidator("json", skillInstallSchema), async (c) => {
      try {
        const s = await installSkill(sharedDir, c.req.valid("json").source, sources);
        return c.json(toSkillView({ name: s.name, description: s.description, scope: "shared", dir: s.dir }), 201);
      } catch (err) {
        if (!(err instanceof SkillInstallError)) throw err;
        return c.json({ error: { code: err.code } }, err.code === "exists" ? 409 : err.code === "download" ? 502 : 400);
      }
    })
    .delete("/:name", (c) => {
      const skill = shared().find((s) => s.name === c.req.param("name"));
      if (!skill) return c.json(notFound, 404);
      removeTree(skill.dir);
      return c.body(null, 204);
    });
}
