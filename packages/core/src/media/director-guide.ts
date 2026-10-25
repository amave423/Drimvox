import type { MediaModel } from "@drimvox/shared";

/** How to write for a family of models: what each one reads well. Matched by the model's id, first match wins. */
const FAMILIES: { match: RegExp; tips: string }[] = [
  {
    match: /flux/i,
    tips: "FLUX reads natural English sentences well: subject, action, setting, lighting, lens and style, most important first. No negative prompts; say what you want instead. Text in the picture goes in quotes.",
  },
  {
    match: /recraft/i,
    tips: "Recraft is strong at illustration, vector style, icons and posters; it renders text well. Short precise English: subject, style (flat vector, line art, 3D, photo), colours, composition.",
  },
  {
    match: /gemini|nano-banana|imagen/i,
    tips: "Google's image models understand plain descriptive language and editing requests (change this, keep that). Describe the scene as a paragraph; for edits say exactly what changes and what stays.",
  },
  {
    match: /gpt-image|dall-?e/i,
    tips: "OpenAI's image models follow long detailed descriptions and render text in quotes accurately. Describe composition, style and every element that must appear.",
  },
  {
    match: /seedream|seededit/i,
    tips: "Seedream follows detailed descriptions in English or Chinese, good at realistic photos and posters with text. Name the style and the shot explicitly.",
  },
  {
    match: /ideogram/i,
    tips: "Ideogram excels at typography and posters: put the exact text in quotes and describe the layout.",
  },
  {
    match: /z-image|qwen-image|sdxl|stable-diffusion|sd-?3/i,
    tips: "A diffusion model on this computer: write in English, concise, comma-separated details from most to least important (subject, style, lighting, quality). Long prompts are cut; keep it under 60 words.",
  },
  {
    match: /veo/i,
    tips: "Veo makes one continuous shot: describe subject, action, setting, camera movement (dolly, pan, static), lighting and mood, and the sound if it adds sound. One scene, no cuts.",
  },
  {
    match: /kling|hailuo|minimax/i,
    tips: "Describe one shot: who, doing what, where, how the camera moves, the style. Keep motion simple and physical; avoid many scene changes.",
  },
  {
    match: /seedance|wan|hunyuan|ltx|sora|grok-imagine|runway|luma|pika/i,
    tips: "A video model: one continuous shot with a clear subject, a simple action and a camera direction; name the visual style. Short, concrete English works best.",
  },
];

/** What the director is told about the model it works with: its options and how to write for it. */
export function promptGuide(model: MediaModel): string {
  const family = FAMILIES.find((f) => f.match.test(model.id))?.tips ?? "Write a concrete English description: subject, setting, style, lighting, composition.";
  const options = [
    model.aspectRatios.length ? `aspect ratios: ${model.aspectRatios.join(", ")}` : "",
    model.resolutions.length ? `resolutions: ${model.resolutions.join(", ")}` : "",
    model.durations.length ? `durations (seconds): ${model.durations.join(", ")}` : "",
    model.photos ? `it takes ${model.photos.max} reference photo(s)${model.photos.min ? " and needs at least one" : ""}` : "",
  ].filter(Boolean);
  return [family, options.length ? `Its options: ${options.join("; ")}. Pass them to the tool only when they matter.` : ""].filter(Boolean).join("\n");
}
