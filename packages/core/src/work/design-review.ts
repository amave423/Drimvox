import type { DesignBrief, ProjectPlan } from "@drimvox/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP, MAX_REVIEW_PAGES, PHONE } from "../agent/design-check";
import { parseReview, reviewQuestion } from "../agent/design";
import { askAboutPictures, mayLookAt, pngOf, type Picture, type Vision } from "../visual/look";
import { reachable, type VisualKit } from "../visual/tools";

/** The project's own design notes the agent keeps (DESIGN.md), read up to this much for the reviewer. */
const NOTES_MAX = 4000;

export interface ReviewDeps {
  kit: VisualKit;
  vision: Vision;
  /** Whose background processes these are: the project's conversation. */
  owner: string;
  folder: string;
  plan: ProjectPlan | null;
  signal: AbortSignal;
  /** A screenshot taken: it goes into the conversation where the review happened. */
  onShot(id: string, url: string, width: number): void;
  onSpend(usd: number): void;
}

/**
 * Drimvox's look at a finished project before it is done (asked for: the agent judged its pages only by "is it there",
 * never by how they look): the result's pages on a desktop and a phone, judged by a model that sees pictures against
 * the plan's design brief and the project's DESIGN.md. The issues for one round of polish, or null when it is good or
 * cannot be looked at.
 */
export async function reviewProjectDesign(d: ReviewDeps, start: { command: string; url: string } | null): Promise<string[] | null> {
  if (!d.kit.screenshot) return null;
  const pages = [...(start ? [start] : []), ...(d.plan?.pages ?? []).map((p) => ({ url: p.url, command: p.command ?? null }))]
    .filter((p, i, all) => mayLookAt(p.url) && all.findIndex((q) => q.url === p.url) === i)
    .slice(0, MAX_REVIEW_PAGES);
  if (pages.length === 0) return null;

  const pictures: Picture[] = [];
  const started: number[] = [];
  try {
    for (const page of pages) {
      // The agent's own server may still be up; otherwise the page's command starts it for the look.
      if (!(await answers(page.url)) && page.command) {
        started.push(d.kit.background.start(d.owner, page.command, d.folder).id);
        if (!(await reachable(page.url, d.signal))) continue;
      }
      for (const size of [DESKTOP, PHONE]) {
        const png = pngOf(await d.kit.screenshot(page.url, size));
        pictures.push({ data: png, mediaType: "image/png" });
        d.onShot(d.kit.shots.save(png), page.url, size.width);
      }
    }
  } catch {
    return null;
  } finally {
    for (const id of started) d.kit.background.stop(d.owner, id);
  }
  if (pictures.length === 0 || d.signal.aborted) return null;

  try {
    const answer = await askAboutPictures(d.vision, pictures, question(d, pictures.length / 2), d.signal);
    d.onSpend(answer.costUsd);
    const review = parseReview(answer.text);
    return review.verdict === "polish" ? review.issues : null;
  } catch {
    return null;
  }
}

/** The review's question: against the plan's brief when there is one, and the project's own design notes. */
function question(d: ReviewDeps, pages: number): string {
  const any = { name: "any", kind: "sans" as const };
  const brief: DesignBrief = d.plan?.design ?? { direction: "—", concept: "No brief was settled: judge it as a clean, modern, well-made interface.", palette: [], fonts: { heading: any, body: any }, rules: [] };
  const file = join(d.folder, "DESIGN.md");
  const notes = existsSync(file) ? readFileSync(file, "utf8").slice(0, NOTES_MAX) : "";
  return [
    reviewQuestion(brief, pages),
    notes ? `\nThe project's own design notes (DESIGN.md):\n${notes}` : "",
    "\nEmoji standing in for icons, default browser controls left unstyled and cramped phone layouts count as issues.",
  ].join("\n");
}

/** Whether something answers at the address right now, without waiting for it. */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** The agent's round of polish after the review: then it looks again and calls finish_work. */
export function polishWorkMessage(issues: string[]): string {
  return [
    "Drimvox's design review looked at the result on a desktop (1280 px) and a phone (390 px) against the design brief and asks for one round of polish before the work is done:",
    ...issues.map((i) => `- ${i}`),
    "Fix these without breaking what works, keep to the brief, look at the pages again, then call finish_work.",
  ].join("\n");
}
