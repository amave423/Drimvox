import type { ActivityEntry, MediaModel, MediaOptions, ModelInfo, ProviderError, StreamEvent } from "@drimvox/shared";
import { isStepCount, streamText, tool, type ModelMessage } from "ai";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ChatRepo } from "../chats/repo";
import { describeError } from "../providers/errors";
import { languageModel } from "../providers/model";
import { costOf, usageOf } from "../providers/pricing";
import type { Connection } from "../providers/repo";
import { askAboutPictures } from "../visual/look";
import { promptGuide } from "./director-guide";
import { downloadVideo, generateImage, pollVideo, submitVideo, type Photo } from "./generate";
import { filmLocally } from "./local";
import type { MediaRepo } from "./repo";

/** The most attempts a user may give: each one is paid. */
export const MAX_ATTEMPTS = 5;
const VIDEO_LIMIT_MS = 30 * 60_000;

export interface DirectorInput {
  chats: ChatRepo;
  media: MediaRepo;
  chatId: string;
  /** The text model that sees pictures: it talks with the user, writes the prompts and looks at the results. */
  director: { conn: Connection; model: string; price: ModelInfo | undefined };
  /** The picture or video model it works with. */
  painter: { conn: Connection; model: MediaModel };
  attempts: number;
  /** Sketches first: one 2x2 collage of four variants, the user picks one, it is then made in full quality. */
  sketches?: boolean;
  content: string;
  options: MediaOptions;
  photos?: { ids: string[]; files: Photo[] };
  signal: AbortSignal;
  pollMs: number;
  emit(event: StreamEvent): Promise<void>;
}

/**
 * A picture or a clip made through a director (docs/specs/media-director.md, asked for: "the text model knows the picture
 * model and its nuances, clarifies, sends it, looks at the result and redoes it"). The director is a text model that
 * sees pictures: it asks what it must, writes the prompt for this very model, looks at each picture and redraws within
 * the attempts the user gave. Clips cannot be looked at: one per message, the user says what to change.
 */
export async function directReply(i: DirectorInput): Promise<void> {
  const { chats } = i;
  const history = chats.history(i.chatId);
  const lastPicture = lastPictureOf(i);
  const added = chats.addMessage({ chatId: i.chatId, role: "user", content: i.content, status: "done" });
  if (i.photos?.ids.length) chats.attachments.attach(i.chatId, added.id, i.photos.ids);
  chats.nameIfUntitled(i.chatId, i.content);
  const answer = chats.addMessage({ chatId: i.chatId, role: "assistant", content: "", status: "streaming", providerId: i.director.conn.id, model: i.director.model });
  await i.emit({ type: "start", userMessage: chats.message(added.id)!, assistantMessageId: answer.id });

  const video = i.painter.model.kind === "video";
  const allowed = video ? 1 : Math.max(1, Math.min(MAX_ATTEMPTS, i.attempts));
  const activity: ActivityEntry[] = [];
  let made = 0;
  let mediaUsd = 0;
  let text = "";
  let error: ProviderError | null = null;
  let input = 0;
  let output = 0;

  const make = tool({
    description: video
      ? "Make the clip with the video model, from the prompt you wrote for it. You cannot watch clips: after it is made, ask the user to look."
      : "Make the picture with the picture model, from the prompt you wrote for it. You get back what is in the picture, seen by you.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(4000).describe("The prompt for this model, in the language and form it works best with"),
      aspect_ratio: z.string().max(20).optional(),
      resolution: z.string().max(20).optional(),
      duration: z.number().int().min(1).max(60).optional(),
    }),
    execute: async ({ prompt, aspect_ratio, resolution, duration }) => {
      if (made >= allowed) return `No attempts left: the user allowed ${allowed}. Tell the user what you made and what could be improved.`;
      made++;
      activity.push({ name: video ? "make_clip" : "make_picture", input: prompt, at: text.length });
      await i.emit({ type: "tool", name: video ? "make_clip" : "make_picture", input: prompt });
      const options: MediaOptions = { ...i.options, ...(aspect_ratio ? { aspectRatio: aspect_ratio } : {}), ...(resolution ? { resolution } : {}), ...(duration ? { duration } : {}) };
      try {
        const result = video ? await film(i, prompt, options) : await generateImage(i.painter.conn, i.painter.model, prompt, options, i.signal, i.photos?.files ?? []);
        mediaUsd += result.costUsd ?? 0;
        i.media.add({ kind: i.painter.model.kind, ...result, prompt, providerId: i.painter.conn.id, model: i.painter.model.id, chatId: i.chatId, messageId: answer.id });
        if (video) return `The clip is made (attempt ${made} of ${allowed}). You cannot watch it: tell the user it is ready and ask what to change.`;
        // The director's own eyes on the picture, against what the user asked for.
        const look = await askAboutPictures(
          i.director,
          [{ data: result.bytes, mediaType: result.mime }],
          [
            `The user asked for: ${i.content}`,
            `The prompt was: ${prompt}`,
            "Describe concretely what the picture shows, and list every place it departs from what the user asked for (composition, objects, text, style, defects).",
            "Answer in the user's language.",
          ].join("\n"),
          i.signal,
        );
        mediaUsd += look.costUsd;
        return `Picture made (attempt ${made} of ${allowed}). What you see in it:\n${look.text}\n${made < allowed ? "If it departs from the request, write a better prompt and make it again; otherwise stop and tell the user." : "That was the last attempt: tell the user what you made."}`;
      } catch (err) {
        const e = describeError(err);
        return `The model failed: ${e.detail ?? e.code}. Try another prompt or tell the user.`;
      }
    },
  });

  const messages: ModelMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content }) as ModelMessage),
    {
      role: "user",
      content: lastPicture
        ? [
            { type: "text", text: `${i.content}\n\n(The last picture made in this chat is attached: the request may be about it.)` },
            { type: "file", data: lastPicture.data, mediaType: lastPicture.mediaType },
          ]
        : i.content,
    },
  ];

  try {
    const result = streamText({
      model: languageModel(i.director.conn, i.director.model),
      system: systemPrompt(i.painter.model, allowed, i.sketches),
      messages,
      tools: { [video ? "make_clip" : "make_picture"]: make },
      stopWhen: isStepCount(allowed * 2 + 4),
      maxRetries: 1,
      abortSignal: i.signal,
      onError: () => {},
    });
    let newStep = false;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        const piece = newStep && text && !/\n\s*$/.test(text) ? `\n\n${part.text.trimStart()}` : part.text;
        newStep = false;
        text += piece;
        await i.emit({ type: "text", text: piece });
      } else if (part.type === "finish-step") newStep = true;
      else if (part.type === "error") error = describeError(part.error);
      else if (part.type === "finish") {
        input += part.totalUsage.inputTokens ?? 0;
        output += part.totalUsage.outputTokens ?? 0;
      }
    }
  } catch (err) {
    error = describeError(err);
  }
  const talk = costOf(i.director.price, i.director.conn.preset, usageOf({ inputTokens: input, outputTokens: output }));
  chats.finishAnswer(answer.id, {
    content: text.trim(),
    reasoning: null,
    status: i.signal.aborted ? "stopped" : error && !made ? "error" : "done",
    inputTokens: input,
    outputTokens: output,
    costUsd: (talk ?? 0) + mediaUsd,
    error: made ? null : error,
    activity,
  });
  await i.emit({ type: "done", message: chats.message(answer.id)! });
}

/** The collage of variants: one cheap picture to choose from, before the dear full one. */
const SKETCH_RULES = [
  "Sketches are on: for a new idea, first make ONE picture that is a 2x2 grid of four clearly different variants of it (different compositions, angles or",
  "styles), with thin plain borders between them and a small number 1-4 in the corner of each. Write the prompt for the grid that way. Then look at it, say",
  "in one line what each variant is, and ask the user which one to develop. Make no other picture in that message.",
  "When the user picks a variant (a number, or describes one), make that variant alone in full quality, as a normal picture, keeping what they liked.",
].join("\n");

function systemPrompt(model: MediaModel, attempts: number, sketches = false): string {
  const what = model.kind === "video" ? "clips" : "pictures";
  return [
    `You are a director for ${what}. You work with one model: ${model.name} (${model.id}).`,
    promptGuide(model),
    "Talk with the user in their language. When the request leaves out something that changes the result a lot (subject, style, format), ask one short round of questions first; otherwise go ahead and decide the rest yourself.",
    `Then write the prompt for this model and call the tool. You may make up to ${attempts} ${attempts === 1 ? "attempt" : "attempts"} for this message.`,
    model.kind === "video"
      ? "You cannot watch clips: after the clip is made, tell the user it is ready and ask what to change."
      : "After each picture you get what is in it: if it departs from the request, write a better prompt and try again; when it matches, stop.",
    "At the end say briefly what you made and, if anything is still off, what the user could ask for. Never paste long prompts into your answer.",
    sketches && model.kind === "image" ? SKETCH_RULES : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The last picture of the chat, for a request about it ("make the background darker"). */
function lastPictureOf(i: DirectorInput): { data: Buffer; mediaType: string } | null {
  if (i.painter.model.kind !== "image") return null;
  const last = (i.chats.get(i.chatId)?.messages ?? []).flatMap((m) => m.media).filter((m) => m.kind === "image").at(-1);
  const file = last ? i.media.file(last.id) : null;
  if (!file) return null;
  try {
    return { data: readFileSync(file.path), mediaType: file.mime };
  } catch {
    return null;
  }
}

/** A clip, waited for here: the director goes on once it is ready. */
async function film(i: DirectorInput, prompt: string, o: MediaOptions): Promise<{ bytes: Buffer; mime: string; costUsd: number | null }> {
  if (i.painter.conn.preset === "sdcpp") return filmLocally(i.painter.model.id, prompt, o, i.signal, i.photos?.files[0]);
  const jobId = await submitVideo(i.painter.conn, i.painter.model, prompt, o, i.photos?.files ?? []);
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, i.pollMs));
    if (i.signal.aborted) throw new Error("Stopped");
    if (Date.now() - started > VIDEO_LIMIT_MS) throw new Error("The clip took too long");
    const state = await pollVideo(i.painter.conn, jobId);
    if (state.state === "failed") throw new Error(state.detail ?? "The clip failed");
    if (state.state === "done") return { ...(await downloadVideo(i.painter.conn, jobId, state.url)), costUsd: state.costUsd };
  }
}
