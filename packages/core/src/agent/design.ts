import { designBriefSchema, lookSchema, type DesignBrief, type FontKind, type Look } from "@artel/shared";
import { z } from "zod";

/**
 * Habits that make every generated interface look alike. The agents are told to avoid them on every step that
 * touches the look; see docs/specs/design.md.
 */
export const CLICHES = [
  "a blue or violet accent picked by habit (#2563eb, #3b82f6, #6366f1 and the like), or a violet-to-blue gradient",
  "everything in identical white rounded cards with a shadow on a grey background",
  "one dark card in the middle of the screen with a coloured glow",
  "emoji in place of icons",
  "one system font for everything, or a font without Cyrillic for an interface in Russian",
  "a big picture with three feature cards under it as the plan of every home page",
  "grey placeholder boxes and lorem ipsum",
  "a destructive button (delete) louder than the main action",
];

const CRAFT = [
  "one scale for text sizes and one for spacing (steps of 4 px), used everywhere",
  "text contrast of at least WCAG AA",
  "a layout that works 375 px wide as well as on a desktop",
  "hover, focus, disabled, empty and loading states",
  "one signature detail that comes from the concept",
];

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

/** For the interview: the question about the look and its samples. */
export function lookInstructions(): string {
  return [
    "If the result has a visible interface (a site, a web app, a screen) and the task does not settle its look, ask about the look",
    "in the first round: offer 2-3 directions that really differ, each derived from the subject and the audience, never just",
    "\"light or dark\". Each option: label is the direction's name, description is its mood in one line, and look gives its",
    "palette (2-6 colours, hex) and the heading and body fonts with their kind (serif, sans, mono or hand). Choose fonts that",
    "are on Google Fonts and support the user's language. If the project already has a style of its own (DESIGN.md, tokens,",
    "settled colours), the recommended option keeps it, with its real colours, next to 1-2 alternatives.",
    "Instead of an option the user may give a link or a picture of a style they like; Artel then describes it for you.",
  ].join("\n");
}

/** For the spec and the team plan: the brief the coders will follow. */
export function briefInstructions(): string {
  return [
    "If the result has a visible interface, add design: the design brief the coders follow. Build it on the direction the user",
    "chose or on the style sample Artel described; when nobody chose, choose yourself from the subject and the audience.",
    "Give the direction's name, the concept in one sentence, the palette by role (background, surface, text, muted text,",
    "accent and so on) in hex, the heading and body fonts, and rules: shapes, density, the signature detail, pictures and icons.",
    `It must not fall into these habits:\n${list(CLICHES)}`,
    "Leave design out when there is nothing to see.",
  ].join("\n");
}

/** For the team plan: how a team builds one look instead of several. */
export function teamDesignNote(): string {
  return [
    "If the goal has a visible interface, the first subtask (id design-system) lays the look's foundation from the brief:",
    "the colour and font tokens, the base elements and one reference screen; the subtasks that build screens depend on it.",
    "Add visual_checks too: how to start the app and the addresses of its main pages, for Artel's design review.",
  ].join("\n");
}

/** The brief as the coders and the design review read it. */
export function briefText(brief: DesignBrief): string {
  return [
    `Direction: ${brief.direction}. ${brief.concept}`,
    `Palette: ${brief.palette.map((c) => `${c.role} ${c.hex}`).join(", ")}`,
    `Fonts: headings ${brief.fonts.heading.name} (${brief.fonts.heading.kind}), text ${brief.fonts.body.name} (${brief.fonts.body.kind})`,
    ...(brief.rules.length ? [`Rules:\n${list(brief.rules)}`] : []),
  ].join("\n");
}

/** For every step that writes code: the brief, where it lives, and the habits to stay away from. */
export function designInstructions(brief: DesignBrief): string {
  return [
    `The look (design brief):\n${briefText(brief)}`,
    "Put the palette and the fonts in one place first (CSS variables or the theme) and take colours only from there.",
    "Load the fonts with a fallback of the same kind. If the project has no DESIGN.md, save this brief there.",
    "Look at your pages a couple of times, not more: once the first full version stands and once before you finish. Do not chase",
    "pixels: Artel's design review looks at the screens on a desktop and a phone after acceptance and sends concrete notes.",
    `Never:\n${list(CLICHES)}`,
    `Always:\n${list(CRAFT)}`,
  ].join("\n");
}

/** What the vision model is asked about the screens. */
export function reviewQuestion(brief: DesignBrief, pages: number): string {
  return [
    `This is Artel's design review. The pictures are ${pages} page(s) of a finished interface, each on a desktop (1280 px)`,
    "and then on a phone (390 px), full length. Judge them as a demanding designer against this brief:",
    "",
    briefText(brief),
    "",
    "Look at the hierarchy, spacing and alignment, contrast, how closely it follows the brief, how it holds up on the phone,",
    `and these habits:\n${list(CLICHES)}`,
    "",
    "Answer GOOD on the first line if it is ready to show, or POLISH if it needs work. After POLISH list up to 8 concrete issues,",
    "most important first, one per line starting with \"- \": where, what is wrong and how to fix it. Write in the language of the brief.",
  ].join("\n");
}

/** What the vision model is asked about a style sample. */
export const STYLE_QUESTION =
  "Describe the visual style of this picture for a designer who will build something in the same spirit: the palette with hex " +
  "values and what each colour is for, the fonts or their kind, the layout and grid, density and spacing, shapes (corners, borders, " +
  "shadows), pictures and icons, and the mood in a few words. Do not describe the content. Answer in Russian if the page is in Russian.";

/** Fonts as models name their kind: "sans-serif", "handwritten", "monospace"… */
function fontKind(kind: string): FontKind {
  const k = kind.toLowerCase();
  if (/mono/.test(k)) return "mono";
  if (/hand|script|brush|cursive/.test(k)) return "hand";
  if (/serif/.test(k) && !/sans/.test(k)) return "serif";
  return "sans";
}
const fontInput = z.object({ name: z.string().min(1).max(80), kind: z.string().max(40).default("sans") });
const colours = (items: string[]) => items.map((c) => c.trim()).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));

/** The samples of an interview option, as models send them; normalized by `toLook`. */
export const lookInput = z
  .object({ palette: z.array(z.string().max(40)).max(10), heading: fontInput, body: fontInput })
  .optional()
  .describe("For a question about the look: the direction's colours (hex) and fonts");

/** Samples that can be drawn, or none: bad colours are dropped, and fewer than two make no palette. */
export function toLook(input: z.infer<typeof lookInput>): Look | undefined {
  if (!input) return undefined;
  const parsed = lookSchema.safeParse({
    palette: colours(input.palette).slice(0, 6),
    heading: { name: input.heading.name.trim(), kind: fontKind(input.heading.kind) },
    body: { name: input.body.name.trim(), kind: fontKind(input.body.kind) },
  });
  return parsed.success ? parsed.data : undefined;
}

/** The brief as models send it with the spec or the plan; normalized by `toBrief`. */
export const briefInput = z
  .object({
    direction: z.string().max(400),
    concept: z.string().max(3000),
    palette: z.array(z.object({ role: z.string().max(200), hex: z.string().max(40) })).max(24),
    fonts: z.object({ heading: fontInput, body: fontInput }),
    rules: z.array(z.string().max(1000)).max(24).default([]),
  })
  .optional()
  .describe("The design brief, when the result has a visible interface: up to 10 colours and 12 rules are kept");

const clip = (text: string, max: number) => (text.trim().length > max ? `${text.trim().slice(0, max - 1).trimEnd()}…` : text.trim());

/**
 * A brief the coders can follow, or none. What says more than a brief keeps is trimmed (seen live: twelve colours threw
 * a good brief away whole); only a brief without a usable palette or fonts is dropped rather than failing the spec.
 */
export function toBrief(input: z.infer<typeof briefInput>): DesignBrief | null {
  if (!input) return null;
  const parsed = designBriefSchema.safeParse({
    direction: clip(input.direction, 120),
    concept: clip(input.concept, 600),
    palette: input.palette
      .filter((c) => colours([c.hex]).length === 1)
      .slice(0, 10)
      .map((c) => ({ role: clip(c.role, 60) || "colour", hex: c.hex.trim() })),
    fonts: {
      heading: { name: clip(input.fonts.heading.name, 80), kind: fontKind(input.fonts.heading.kind) },
      body: { name: clip(input.fonts.body.name, 80), kind: fontKind(input.fonts.body.kind) },
    },
    rules: input.rules
      .map((r) => clip(r, 400))
      .filter(Boolean)
      .slice(0, 12),
  });
  return parsed.success ? parsed.data : null;
}

/** The review's answer: GOOD, or POLISH with the issues listed one per line. */
export function parseReview(answer: string): { verdict: "good" | "polish"; issues: string[] } {
  const lines = answer.split(/\r?\n/).map((l) => l.trim());
  const issues = lines
    .filter((l) => /^([-*•]|\d+[.)])\s+/.test(l))
    .map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const polish = /\bPOLISH\b/i.test(lines.find(Boolean) ?? "") && issues.length > 0;
  return { verdict: polish ? "polish" : "good", issues: polish ? issues : [] };
}

/** The coder's round of polish after the review. */
export function polishMessage(issues: string[]): string {
  return [
    "Artel's design review looked at the screens on a desktop and a phone against the brief and asks for one round of polish:",
    list(issues),
    "Fix these without breaking anything that works and keep to the brief. Run the checks, then call finish.",
  ].join("\n");
}
