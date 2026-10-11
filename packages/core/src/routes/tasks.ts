import { zValidator } from "@hono/zod-validator";
import { approvalAnswerSchema, taskAcceptSchema, taskContinueSchema, taskFeedbackSchema } from "@artel/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { GitError } from "../agent/git";
import type { TaskRepo } from "../agent/repo";
import { AcceptRefused } from "../agent/review";
import { TaskBusy, type AgentRunner, type TaskUpdate } from "../agent/runner";

const notFound = { error: { code: "not_found" } } as const;

/** Maps the runner's refusals to 409 answers; anything else is a real failure. */
function refusal(err: unknown) {
  if (err instanceof AcceptRefused) return { error: { code: err.code, files: err.files } };
  if (err instanceof TaskBusy) return { error: { code: "busy" as string, files: [] as string[] } };
  if (err instanceof GitError) return { error: { code: err.code as string, files: [] as string[] } };
  throw err;
}

export function taskRoutes(tasks: TaskRepo, runner: AgentRunner) {
  return new Hono()
    .get("/", (c) => c.json(tasks.list().map((t) => runner.view(t.id)!)))
    .get("/:id", (c) => {
      const task = runner.view(c.req.param("id"));
      return task ? c.json(task, 200) : c.json(notFound, 404);
    })
    .get("/:id/events", zValidator("query", z.object({ after: z.coerce.number().int().min(0).default(0) })), (c) => {
      const id = c.req.param("id");
      if (!runner.view(id)) return c.json(notFound, 404);
      return c.json(tasks.events(id, c.req.valid("query").after), 200);
    })
    .get("/:id/stream", zValidator("query", z.object({ after: z.coerce.number().int().min(0).default(0) })), (c) => {
      const id = c.req.param("id");
      if (!runner.view(id)) return c.json(notFound, 404);
      const after = c.req.valid("query").after;
      return streamSSE(c, async (stream) => {
        const queue: TaskUpdate[] = [];
        let wake: (() => void) | null = null;
        let closed = false;
        const unsubscribe = runner.subscribe(id, (update) => {
          queue.push(update);
          wake?.();
        });
        stream.onAbort(() => {
          closed = true;
          wake?.();
        });

        const send = (update: TaskUpdate) => stream.writeSSE({ data: JSON.stringify(update) });
        let lastSeq = after;
        await send({ type: "task", task: runner.view(id)! });
        for (const event of tasks.events(id, after)) {
          await send({ type: "event", event });
          lastSeq = event.seq;
        }
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
              setTimeout(r, 15_000);
            });
            wake = null;
            if (queue.length === 0 && !closed) await stream.writeSSE({ event: "ping", data: "" });
          }
          for (const update of queue.splice(0)) {
            if (update.type === "event") {
              if (update.event.seq <= lastSeq) continue;
              lastSeq = update.event.seq;
            }
            if (!closed) await send(update);
          }
        }
        unsubscribe();
      });
    })
    .post("/:id/stop", (c) => {
      const id = c.req.param("id");
      if (!runner.view(id)) return c.json(notFound, 404);
      runner.stop(id);
      return c.json(runner.view(id)!, 200);
    })
    .post("/:id/approvals/:approvalId", zValidator("json", approvalAnswerSchema), (c) => {
      const id = c.req.param("id");
      if (!runner.answer(id, c.req.param("approvalId"), c.req.valid("json").allow)) return c.json(notFound, 404);
      return c.json(runner.view(id)!, 200);
    })
    .post("/:id/continue", zValidator("json", taskContinueSchema), (c) => {
      const id = c.req.param("id");
      if (!runner.view(id)) return c.json(notFound, 404);
      try {
        return c.json(runner.continue(id, c.req.valid("json").note), 200);
      } catch (err) {
        return c.json(refusal(err), 409);
      }
    })
    .post("/:id/feedback", zValidator("json", taskFeedbackSchema), (c) => {
      const id = c.req.param("id");
      if (!runner.view(id)) return c.json(notFound, 404);
      try {
        return c.json(runner.feedback(id, c.req.valid("json")), 200);
      } catch (err) {
        return c.json(refusal(err), 409);
      }
    })
    .get("/:id/diff", async (c) => {
      const diff = await runner.diff(c.req.param("id"));
      return diff ? c.json(diff, 200) : c.json(notFound, 404);
    })
    .post("/:id/accept", zValidator("json", taskAcceptSchema), async (c) => {
      const id = c.req.param("id");
      if (!runner.view(id)) return c.json(notFound, 404);
      try {
        const commit = await runner.accept(id, c.req.valid("json").message);
        return c.json({ commit, task: runner.view(id)! }, 200);
      } catch (err) {
        return c.json(refusal(err), 409);
      }
    })
    .post("/:id/discard", async (c) => {
      const id = c.req.param("id");
      if (!runner.view(id)) return c.json(notFound, 404);
      try {
        await runner.discard(id);
        return c.json(runner.view(id)!, 200);
      } catch (err) {
        return c.json(refusal(err), 409);
      }
    });
}
