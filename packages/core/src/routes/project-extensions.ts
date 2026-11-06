import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { ProjectRepo } from "../agent/repo";
import type { McpRepo } from "../mcp/repo";
import type { ProjectExtensions } from "../projects/extensions";
import { findSkills, projectSkillRoots } from "../skills/skills";

const notFound = { error: { code: "not_found" } } as const;

const choiceSchema = z
  .object({
    skills: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
    mcp: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  })
  .strict();

/**
 * A project's skills and MCP servers (asked for: downloaded in the settings, switched on per project). The project's
 * own skills, in its folder, are always on; the downloaded ones and the added servers are on as the project chose.
 */
export function projectExtensionRoutes(projects: ProjectRepo, extensions: ProjectExtensions, mcp: McpRepo, skillsDir: string) {
  const view = (projectId: string, folder: string) => {
    const choice = extensions.get(projectId);
    const own = findSkills(projectSkillRoots(folder)).map((s) => ({ name: s.name, description: s.description, own: true, on: true }));
    const shared = findSkills([{ dir: skillsDir, scope: "shared" }]).map((s) => ({
      name: s.name,
      description: s.description,
      own: false,
      on: choice.skills === null || choice.skills.includes(s.name),
    }));
    const servers = mcp.list().map((s) => ({ id: s.id, name: s.name, on: s.enabled && (choice.mcp === null || choice.mcp.includes(s.id)), installed: s.enabled }));
    return { skills: [...own, ...shared], mcp: servers };
  };
  return new Hono()
    .get("/:id/extensions", (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      return c.json(view(project.id, project.path), 200);
    })
    .put("/:id/extensions", zValidator("json", choiceSchema), (c) => {
      const project = projects.get(c.req.param("id"));
      if (!project) return c.json(notFound, 404);
      const { skills, mcp: servers } = c.req.valid("json");
      extensions.set(project.id, { ...(skills !== undefined ? { skills } : {}), ...(servers !== undefined ? { mcp: servers } : {}) });
      return c.json(view(project.id, project.path), 200);
    });
}
