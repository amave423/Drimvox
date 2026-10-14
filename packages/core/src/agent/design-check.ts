import type { DesignBrief, DesignReview, StyleReference, VisualCheck } from "@artel/shared";
import { askAboutPictures, mayLookAt, type Picture } from "../visual/look";
import { reachable, type VisualDeps } from "../visual/tools";
import { parseReview, polishMessage, reviewQuestion, STYLE_QUESTION } from "./design";
import { pagesUpTo } from "./landing";
import type { PassContext } from "./pass";

export const DESKTOP = { width: 1280, height: 800 };
export const PHONE = { width: 390, height: 844 };
/** Pages photographed for one review: each on a desktop and a phone. */
export const MAX_REVIEW_PAGES = 2;

export type DesignRound = { kind: "pass" } | { kind: "polish"; message: string } | { kind: "stopped" };

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What looking cost goes into the task's spending at once, like pictures and screenshots do. */
function spend(ctx: PassContext, id: string, usd: number): void {
  if (usd <= 0) return;
  ctx.tasks.update(id, { cost_usd: ctx.tasks.row(id)!.cost_usd + usd });
  ctx.tasks.addUsage(id, 0, 0, usd, true);
  ctx.publish();
}

/**
 * Artel's design review of the current stage, once, after the acceptance agent accepted every requirement:
 * the pages on a desktop and a phone, judged against the brief. "polish" carries the one round of rework.
 */
export async function designRound(ctx: PassContext, id: string, visual: VisualDeps): Promise<DesignRound> {
  const row = ctx.tasks.row(id)!;
  if (!row.design || row.design_reviewed) return { kind: "pass" };
  ctx.tasks.update(id, { design_reviewed: 1 });
  const brief = JSON.parse(row.design) as DesignBrief;
  const pages = pagesUpTo(JSON.parse(row.visual) as VisualCheck[], row.milestone)
    .filter((p) => mayLookAt(p.url))
    .slice(0, MAX_REVIEW_PAGES);
  const skip = (why: string): DesignRound => {
    ctx.event("text", { text: `Artel skipped the design review: ${why}.` });
    return { kind: "pass" };
  };
  if (pages.length === 0) return skip("there are no pages to look at");
  if (!visual.vision || !visual.kit.screenshot) return skip("there is no model that sees pictures (pick one in the settings) or no way to take screenshots here");

  ctx.event("phase", { phase: "design_review" });
  const pictures: Picture[] = [];
  const shots: string[] = [];
  const started: number[] = [];
  try {
    for (const page of pages) {
      if (page.start) {
        started.push(visual.kit.background.start(id, page.start, row.worktree).id);
        if (!(await reachable(page.url, ctx.signal))) continue;
      }
      for (const size of [DESKTOP, PHONE]) {
        const png = await visual.kit.screenshot(page.url, size);
        const shot = visual.kit.shots.save(png);
        ctx.event("screenshot", { id: shot, url: page.url, width: size.width });
        shots.push(shot);
        pictures.push({ data: png, mediaType: "image/png" });
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) return { kind: "stopped" };
    return skip(`the pages could not be photographed (${reason(err)})`);
  } finally {
    for (const p of started) visual.kit.background.stop(id, p);
  }
  if (ctx.signal.aborted) return { kind: "stopped" };
  if (pictures.length === 0) return skip("the pages did not answer");

  let answer: { text: string; costUsd: number };
  try {
    answer = await askAboutPictures(visual.vision, pictures, reviewQuestion(brief, pictures.length / 2), ctx.signal);
  } catch (err) {
    if (ctx.signal.aborted) return { kind: "stopped" };
    return skip(`the model could not look at the screens (${reason(err)})`);
  }
  spend(ctx, id, answer.costUsd);
  const review: DesignReview = { ...parseReview(answer.text), shots, model: visual.vision.model };
  ctx.tasks.update(id, { design_review: JSON.stringify(review) });
  ctx.event("design_review", review);
  return review.verdict === "polish" ? { kind: "polish", message: polishMessage(review.issues) } : { kind: "pass" };
}

/**
 * A site or a picture the user gave as a style sample: Artel photographs or takes it, the vision model describes
 * its style, and the description goes to the agent with the answers. Returns that part of the message.
 */
export async function describeReference(ctx: PassContext, id: string, ref: StyleReference): Promise<string> {
  const row = ctx.tasks.row(id)!;
  const kit = ctx.visualKit;
  const vision = await ctx.vision(row);
  const what = ref.url ? `the site ${ref.url}` : "a picture";
  let picture: Picture | null = null;
  const image = ref.image?.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (image) picture = { data: Buffer.from(image[2]!, "base64"), mediaType: image[1]! };

  let description: string | null = null;
  let why = "";
  if (!vision) why = "there is no model that sees pictures";
  else if (!picture && ref.url && !kit.screenshot) why = "there is no way to take screenshots here";
  else if (!picture && ref.url && !mayLookAt(ref.url)) why = "only public addresses can be opened";
  else {
    try {
      picture ??= { data: await kit.screenshot!(ref.url!, DESKTOP), mediaType: "image/png" };
      const answer = await askAboutPictures(vision, [picture], STYLE_QUESTION, ctx.signal);
      spend(ctx, id, answer.costUsd);
      description = answer.text || null;
      if (!description) why = "the model said nothing";
    } catch (err) {
      why = reason(err);
    }
  }
  const shot = picture ? kit.shots.save(picture.data) : null;
  ctx.event("reference", { url: ref.url ?? null, shot, description });

  if (description) {
    return `The user gave ${what} as a sample of the style they like. Artel looked at it:\n${description}\nBase the look on this sample unless the answers say otherwise.`;
  }
  return ref.url
    ? `The user gave ${what} as a sample of the style they like, but Artel could not look at it (${why}). Open it with open_page if you need to.`
    : `The user gave ${what} as a sample of the style they like, but Artel could not look at it (${why}).`;
}
