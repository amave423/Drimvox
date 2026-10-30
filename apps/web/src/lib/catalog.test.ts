import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";

describe("catalog cards", () => {
  // Seen: two skills drew the same sparkles and two more the same check mark, so the cards could not be told apart.
  it("gives every card a mark of its own", () => {
    const ids = new Map<string, string[]>();
    for (const entry of CATALOG) ids.set(entry.logo.path, [...(ids.get(entry.logo.path) ?? []), entry.id]);
    expect([...ids.values()].filter((sharing) => sharing.length > 1)).toEqual([]);
  });

  // A card is found by its id when a server or a skill is switched on from it.
  it("keeps the ids unique", () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
  });
});
