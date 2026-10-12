import { zValidator } from "@hono/zod-validator";
import { skillCreateSchema, skillImportSchema } from "@artel/shared";
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { copyTree, removeTree } from "../fsx";
import { findSkills, parseSkill, skillSlug, toSkillView } from "../skills/skills";

const notFound = { error: { code: "not_found" } } as const;

/** Shared skills: in Artel's data folder, for every project. */
export function skillRoutes(sharedDir: string) {
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
    .delete("/:name", (c) => {
      const skill = shared().find((s) => s.name === c.req.param("name"));
      if (!skill) return c.json(notFound, 404);
      removeTree(skill.dir);
      return c.body(null, 204);
    });
}
