import { zValidator } from "@hono/zod-validator";
import { modelChainsSchema } from "@drimvox/shared";
import { Hono } from "hono";
import type { Chains } from "../providers/chains";

/** Chains of free models (docs/specs/model-chains.md): every chain with its models' state; the user's saved whole. */
export function chainRoutes(chains: Chains) {
  return new Hono()
    .get("/", async (c) => c.json(await chains.views(), 200))
    .get("/free", async (c) => c.json(await chains.free(), 200))
    .put("/", zValidator("json", modelChainsSchema), async (c) => {
      // Drimvox's own chains are made, not saved: only the user's go in.
      chains.save(c.req.valid("json").filter((ch) => !ch.id.startsWith("auto-")));
      return c.json(await chains.views(), 200);
    });
}
