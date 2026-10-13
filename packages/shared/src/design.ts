import { z } from "zod";

/** What a font looks like, so the interface can draw a sample with the nearest font it has. */
export const fontKinds = ["serif", "sans", "mono", "hand"] as const;
export type FontKind = (typeof fontKinds)[number];

const hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/);
const fontSchema = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(fontKinds) });
export type FontChoice = z.infer<typeof fontSchema>;

/** The samples of one visual direction offered in the interview: its colours and its two fonts. */
export const lookSchema = z.object({
  palette: z.array(hex).min(2).max(6),
  heading: fontSchema,
  body: fontSchema,
});
export type Look = z.infer<typeof lookSchema>;

/** The look the coders follow: written with the spec or the plan, shown to the user, kept as DESIGN.md in the project. */
export const designBriefSchema = z.object({
  /** The direction's name, such as "Chalkboard menu". */
  direction: z.string().trim().min(1).max(120),
  /** The idea in one sentence, tied to the subject and the audience. */
  concept: z.string().trim().min(1).max(600),
  palette: z
    .array(z.object({ role: z.string().trim().min(1).max(60), hex }))
    .min(2)
    .max(10),
  fonts: z.object({ heading: fontSchema, body: fontSchema }),
  /** Shapes, density, the signature detail, pictures: short rules the coder can follow. */
  rules: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
});
export type DesignBrief = z.infer<typeof designBriefSchema>;

/** Artel's look at the finished screens against the brief: fine as it is, or one round of polish. */
export interface DesignReview {
  verdict: "good" | "polish";
  /** Where, what is wrong and how to fix it; most important first. */
  issues: string[];
  /** Screenshot ids: desktop and phone for each page. */
  shots: string[];
  /** The model that looked. */
  model: string;
}

/** Pictures the user may give as a style sample. */
export const referenceImageTypes = ["image/png", "image/jpeg", "image/webp"] as const;
/** Up to 5 MB of picture, which is about 6.7 million characters of base64. */
export const MAX_REFERENCE_CHARS = 7_000_000;

/** A sample of the style the user likes: a site's address or a picture. */
export const styleReferenceSchema = z
  .object({
    url: z.string().trim().url().max(2000).optional(),
    image: z
      .string()
      .max(MAX_REFERENCE_CHARS)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
      .optional(),
  })
  .refine((r) => !!r.url || !!r.image, "A link or a picture");
export type StyleReference = z.infer<typeof styleReferenceSchema>;
