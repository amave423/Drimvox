import { MAX_WAIT_MS } from "@drimvox/shared";
import { z } from "zod";

/** Steps done on a page before it is read or photographed, as a person would: click, type, press a key, wait. */
export const pageStepsInput = z
  .array(
    z.object({
      action: z.enum(["click", "type", "press", "wait"]),
      target: z.string().min(1).max(300).optional().describe("Visible text, label, placeholder or CSS selector"),
      text: z.string().max(2000).optional().describe("What to type, or the key to press"),
      ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    }),
  )
  .max(20)
  .optional();
