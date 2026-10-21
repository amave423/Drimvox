import type { MediaModel, MediaOptions, ProviderError, StreamEvent } from "@artel/shared";
import type { ChatRepo, PendingJob } from "../chats/repo";
import { describeError } from "../providers/errors";
import type { Connection, ProviderRepo } from "../providers/repo";
import { downloadVideo, generateImage, pollVideo, submitVideo, type Photo } from "./generate";
import { filmLocally } from "./local";
import type { MediaRepo } from "./repo";

/** Clips that take longer than this are given up on. */
const VIDEO_LIMIT_MS = 60 * 60_000;
/** Status requests may fail now and then; this many in a row end the wait. */
const MAX_POLL_FAILURES = 20;

export interface StudioOptions {
  chats: ChatRepo;
  media: MediaRepo;
  providers: ProviderRepo;
  /** How often a clip's job is checked. */
  pollMs: number;
}

/** Pictures and clips in chats: the answer, the file, the price, and the wait for clips. */
export class Studio {
  private readonly stop = new AbortController();
  private readonly watched = new Set<string>();

  constructor(private readonly o: StudioOptions) {}

  /** Picks up clips that were still rendering when Drimvox closed. */
  resume(): void {
    for (const job of this.o.chats.pendingJobs()) {
      const conn = job.providerId ? this.o.providers.connection(job.providerId) : null;
      if (conn) this.watch(conn, job);
      else this.fail(job.messageId, { code: "no_key" });
    }
  }

  async reply(i: {
    chatId: string;
    conn: Connection;
    model: MediaModel;
    prompt: string;
    options: MediaOptions;
    /** Photos for a model that takes them (checked before), with their uploads to show under the request. */
    photos?: { ids: string[]; files: Photo[] };
    emit(event: StreamEvent): Promise<void>;
  }): Promise<void> {
    const { chats } = this.o;
    const added = chats.addMessage({ chatId: i.chatId, role: "user", content: i.prompt, status: "done" });
    if (i.photos?.ids.length) chats.attachments.attach(i.chatId, added.id, i.photos.ids);
    const userMessage = chats.message(added.id)!;
    const photos = i.photos?.files ?? [];
    chats.nameIfUntitled(i.chatId, i.prompt);
    const answer = chats.addMessage({ chatId: i.chatId, role: "assistant", content: "", status: "streaming", providerId: i.conn.id, model: i.model.id });
    await i.emit({ type: "start", userMessage, assistantMessageId: answer.id });

    try {
      if (i.model.kind === "image" || i.conn.preset === "sdcpp") {
        // A picture, or a clip made on this computer: either is ready when the call returns.
        const picture =
          i.model.kind === "image"
            ? await generateImage(i.conn, i.model, i.prompt, i.options, this.stop.signal, photos)
            : await filmLocally(i.model.id, i.prompt, i.options, this.stop.signal, photos[0]);
        this.o.media.add({
          kind: i.model.kind,
          ...picture,
          prompt: i.prompt,
          providerId: i.conn.id,
          model: i.model.id,
          chatId: i.chatId,
          messageId: answer.id,
        });
        this.finish(answer.id, picture.costUsd);
      } else {
        const jobId = await submitVideo(i.conn, i.model, i.prompt, i.options, photos);
        chats.setMediaJob(answer.id, jobId);
        this.watch(i.conn, {
          messageId: answer.id,
          chatId: i.chatId,
          providerId: i.conn.id,
          model: i.model.id,
          prompt: i.prompt,
          jobId,
          createdAt: answer.createdAt,
        });
      }
    } catch (err) {
      this.fail(answer.id, describeError(err));
    }
    await i.emit({ type: "done", message: chats.message(answer.id)! });
  }

  shutdown(): void {
    this.stop.abort();
  }

  private watch(conn: Connection, job: PendingJob): void {
    if (this.watched.has(job.messageId)) return;
    this.watched.add(job.messageId);
    void this.wait(conn, job).finally(() => this.watched.delete(job.messageId));
  }

  private async wait(conn: Connection, job: PendingJob): Promise<void> {
    let failures = 0;
    while (!this.stop.signal.aborted) {
      await sleep(this.o.pollMs, this.stop.signal);
      if (this.stop.signal.aborted) return;
      if (Date.now() - job.createdAt > VIDEO_LIMIT_MS) return this.fail(job.messageId, { code: "timeout" });
      let state;
      try {
        state = await pollVideo(conn, job.jobId);
        failures = 0;
      } catch (err) {
        if (++failures >= MAX_POLL_FAILURES) return this.fail(job.messageId, describeError(err));
        continue;
      }
      if (this.stop.signal.aborted) return;
      if (state.state === "failed") return this.fail(job.messageId, { code: "provider_error", detail: state.detail });
      if (state.state !== "done") continue;
      try {
        const clip = await downloadVideo(conn, job.jobId, state.url);
        if (this.stop.signal.aborted) return;
        this.o.media.add({
          kind: "video",
          ...clip,
          costUsd: state.costUsd,
          prompt: job.prompt,
          providerId: job.providerId,
          model: job.model,
          chatId: job.chatId,
          messageId: job.messageId,
        });
        return this.finish(job.messageId, state.costUsd);
      } catch (err) {
        return this.fail(job.messageId, describeError(err));
      }
    }
  }

  private finish(messageId: string, costUsd: number | null): void {
    this.o.chats.setMediaJob(messageId, null);
    this.o.chats.finishAnswer(messageId, { content: "", reasoning: null, status: "done", inputTokens: null, outputTokens: null, costUsd, error: null });
  }

  private fail(messageId: string, error: ProviderError): void {
    this.o.chats.setMediaJob(messageId, null);
    this.o.chats.finishAnswer(messageId, { content: "", reasoning: null, status: "error", inputTokens: null, outputTokens: null, costUsd: null, error });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
