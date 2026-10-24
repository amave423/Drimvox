import { z } from "zod";

/** Where models search the web: the free search (DuckDuckGo, often limited) or a service with the user's key. */
export const searchServices = ["free", "tavily", "brave"] as const;
export type SearchService = (typeof searchServices)[number];

export const searchSetSchema = z
  .object({
    service: z.enum(["tavily", "brave"]),
    key: z.string().trim().min(1).max(300),
  })
  .strict();

/** A search to try the key with; "test" when not given. */
export const searchCheckSchema = z.object({ query: z.string().trim().min(1).max(200).optional() }).strict();

/** The search setting as the interface sees it: the key never leaves the core. */
export interface SearchView {
  service: SearchService;
  hasKey: boolean;
}

export interface SearchCheck {
  ok: boolean;
  ms?: number;
  results?: { title: string; url: string; snippet: string }[];
  /** auth: the key is wrong; limit: the plan's searches are used up; failed: anything else. */
  error?: { code: "auth" | "limit" | "failed"; detail?: string };
}
