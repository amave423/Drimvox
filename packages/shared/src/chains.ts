import { z } from "zod";
import { modelRefSchema } from "./tasks";

/**
 * Chains of free models (docs/specs/model-chains.md): a chain is picked like a model; under it free models answer in turn,
 * and one that hit its limit, fails or keeps silent hands the question to the next and rests.
 */
export const CHAIN_PROVIDER_ID = "chain";
/** Chains Drimvox makes itself from every free model it knows: one for work with tools, one for talk. */
export const autoChainIds = ["auto-code", "auto-chat"] as const;

export const modelChainSchema = z
  .object({
    id: z.string().min(1).max(60),
    name: z.string().trim().min(1).max(80),
    models: z.array(modelRefSchema).max(20),
    /** list: in the order given; best: the ones that answered best here first. */
    order: z.enum(["list", "best"]),
    /** Go on to the next on a limit (429), on a server error, and after this many seconds of silence (null: wait). */
    onLimit: z.boolean(),
    onError: z.boolean(),
    timeoutS: z.number().int().min(5).max(300).nullable(),
    /** Only models that call tools: such a chain can work in a project. */
    toolsOnly: z.boolean(),
  })
  .strict();
export type ModelChain = z.infer<typeof modelChainSchema>;
export const modelChainsSchema = z.array(modelChainSchema).max(50);

export const newChain = (id: string, name: string): ModelChain => ({ id, name, models: [], order: "list", onLimit: true, onError: true, timeoutS: 20, toolsOnly: false });

export interface ChainMember {
  providerId: string;
  model: string;
  name: string;
  providerName: string;
  /** ok: answered last time or not tried; resting: hit its limit or failed, rests until `until`. */
  state: "ok" | "resting";
  until: number | null;
}

export interface ChainView extends ModelChain {
  /** Made by Drimvox from the free models; its models and rules are not edited. */
  auto: boolean;
  members: ChainMember[];
  /** The model that answered last, as "provider / model". */
  answered: string | null;
}
