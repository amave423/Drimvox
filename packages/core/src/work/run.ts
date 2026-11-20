import type { ActivityEntry, MonthUsage, ProviderError, StreamEvent } from "@drimvox/shared";
import { inConversation } from "../providers/session";
import type { McpAsk, McpHooks } from "../mcp/hub";
import { fitContext } from "./context";
import { HELD, keepChecked, lastChecked, NOTHING_TO_CHECK, PUBLISHES } from "./publish";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { runAgent } from "../agent/run";
import { isFreeToRun, isLocal } from "../budget";
import type { ToolHooks } from "../agent/tools";
import type { ChatApprovals } from "../chats/approvals";
import type { ChatQuestions } from "../chats/questions";
import { describeCall, folderTools } from "../chats/folder";
import { toModelMessages, DATA_HINT, FACTS_HINT, HONEST_HINT } from "../chats/history";
import type { ChatRepo } from "../chats/repo";
import { webTools } from "../internet/tools";
import type { WebAccess } from "../internet/web";
import { todayLine } from "../now";
import { findModel } from "../providers/catalog";
import { pinnedRates, unpinCheapest } from "../providers/routing";
import { usdRub } from "../rates";
import type { Connection, ProviderRepo } from "../providers/repo";
import { findSkills, projectSkillRoots, skillsInstructions, skillTools } from "../skills/skills";
import { askAboutPictures, type Vision } from "../visual/look";
import { visualTools, type VisualKit } from "../visual/tools";
import { stopLeftovers } from "../agent/leftovers";
import { fitForModel } from "../tools/images";
import { CHECK_ROUNDS, checkWork, findingsMessage, type CheckResult } from "./check";
import type { ProjectGit } from "./project-git";
import { changedSince, checkpoint, diffSince, dropCheckpoint, treeOf } from "../chats/checkpoint";
import { weakenedNote, weakenedTests } from "./weakened";
import { changedScreens, keepRecipe, readRecipe } from "./tester-memory";
import { electronApp, packagedNote } from "./packaged-check";
import { reviewCode, reviewMessage, type ReviewResult } from "./review";
import { mirrorNotes, notesBlock, notesChangedSince, writeState } from "../agent/notes";
import { toolbox, type ToolboxDeps } from "../tools";
import { sshNote } from "../tools/ssh";
import { memoryLimit, remember } from "../agent/memory";
import type { ProjectWorkRepo } from "./repo";
import { projectMap } from "../agent/repo-map";
import { proxyHint } from "../internet/blocked";
import { lineStat } from "./line-stat";
import { subagentTools } from "../agent/subagent";
import { LANGUAGE_HINT } from "../chats/reply";
import { agentPrompt } from "./agent-prompt";
import { oneBrowser } from "../browser/one";
import { isRare } from "../agent/deferred";

/** Steps one answer of the run takes before the next answer goes on with the same context. */
export const SEGMENT_STEPS = 60;
/** Drimvox's word to a project worked as a chat, at every 60 steps of one answer. */
export const DONE_YET =
  "[Drimvox: 60 steps on this message.] If what the user asked is done and nothing is broken, stop now and reply what you made. Otherwise go on with what is left, without polishing what already works.";
/**
 * The agent ended its answer saying the work is not done, with money and time left: it goes on (asked for, after GPT-6
 * Luna twice stopped with "the work is not finished" on a long list, waiting, while DeepSeek went on by itself). At most
 * `CONTINUES` times in a row; a decision only the user can make comes as a question, which waits for the user.
 */
export const GO_ON =
  "[Drimvox: you said the work is not finished, and there is money and time left.] Go on with what is left of the user's request now. Stop only when it is done, or ask with the question tool when a decision only the user can make is missing.";
export const CONTINUES = 2;
/**
 * Asked for: the project's AGENTS.md kept current, so a new conversation or another agent can go on. A turn that changed
 * files and left the notes as they were is asked for them once.
 */
export const NOTES_DUE =
  "[Drimvox: this turn changed the project, and your notes are as they were before it.] Bring them up to date with update_notes now: what changed, how to run and check it, what is done and what is next. They are copied into AGENTS.md in the project for whoever continues: commit that file with your work. Then end your turn as before.";
/** Words of an answer that leaves the asked work unfinished (narrow: "not checked live" is a finished answer). */
const UNFINISHED =
  /работа не завершена|не завершил|не закончил|не доделал|не успел|осталось (сделать|доделать|реализовать)|ещё не сделан|\bnot (yet )?(finished|complete|done)\b|\bincomplete\b|\bremaining (work|items|tasks)\b/i;
// Markdown marks are left out: agents write "**не завершена**".
export const unfinished = (said: string) => UNFINISHED.test(said.replace(/[*_`]/g, ""));

/** After a clean check: what the agent held back for the tester goes out now (agent-prompt.ts). */
export const CLEAN_CHECK =
  "[Drimvox's tester tried your work as the user will and found nothing.] If the user asked to publish it (a release, a deploy, an upload), do it now. Otherwise reply in one line that it is checked.";
/**
 * The limits of a message's money and time (asked for: the agent should know when it nears them, without hurrying or
 * doing worse, and end a task it cannot finish in a working state instead of breaking off mid-edit). Nothing is said
 * before NEAR_SHARE of a limit is used: early words about limits make a model rush.
 */
const NEAR_SHARE = 0.8;
/** At the limit: how far past it the agent may go to leave the code working, and in how many steps. */
const GRACE = 1.15;
const GRACE_STEPS = 12;
export const WRAP_UP =
  "[Drimvox: the limit of money or time for this message is reached.] Do not start anything new. Leave the code working: finish or undo the change you are in the middle of, make sure it builds and its tests pass, commit, and reply with what is done and what is left.";
/** Said with every step past NEAR_SHARE of a limit. */
export function nearLimit(usedShare: number, left: string): string {
  return `[Drimvox: ${Math.round(usedShare * 100)} % of this message's limit is used, ${left} left.] Keep the same care: do not hurry or skip checks. If what was asked is done, stop now. If not, plan to end in a working state within what is left: finish the piece you are on so it builds and runs, commit it, and say what is left; start nothing big.`;
}
/** Provider errors in a row before the run stops and waits. */
const MAX_ERRORS = 2;
const RETRY_MS = 5000;
/**
 * A provider that is busy, unreachable or cut its answer off on the way gets more tries, each after a longer pause (seen
 * live: a long answer of DeepSeek through RouterAI broke off mid-stream twice in a row, and the run stopped in the middle
 * of the voice of an app with nothing wrong in the work).
 */
const TRANSIENT = new Set(["bad_response", "unreachable", "overloaded", "rate_limited", "timeout"]);
const TRANSIENT_WAITS_MS = [5_000, 15_000, 30_000, 60_000];

/** How long to wait before trying again after the `failures`-th error in a row of this kind; null: stop trying. */
export function retryWait(code: string, failures: number): number | null {
  if (TRANSIENT.has(code)) return TRANSIENT_WAITS_MS[failures - 1] ?? null;
  return failures < MAX_ERRORS ? RETRY_MS : null;
}
/** Looks at pages per answer: the desktop and the phone, scenarios, and again after fixes. */
const LOOKS = {
  looks: 8,
  then: "You have looked at pages enough in this answer: go on with the work, you can look again in the next one, or use browser_look. Never install Playwright or write screenshot scripts.",
};

export interface RunDeps {
  chats: ChatRepo;
  providers: ProviderRepo;
  approvals: ChatApprovals;
  questions: ChatQuestions;
  repo: ProjectWorkRepo;
  visualKit: VisualKit;
  web: WebAccess;
  skillsDir: string;
  /** Tools of the user's MCP servers; their questions come into the project's conversation. */
  mcp?: { toolsFor(ask: McpAsk, hooks: McpHooks, only?: (serverId: string) => boolean): Promise<ToolSet> };
  /** The downloaded skills and the MCP servers this project switched on; null in either: all of them. */
  extensions?(projectId: string): {
    skills: string[] | null;
    mcp: string[] | null;
    vision: { providerId: string; model: string } | null;
    service: { providerId: string; model: string } | null;
    /** The tester after an answer that changed files (check.ts); on unless switched off. */
    check?: boolean;
    review?: boolean;
  };
  idleTimeoutMs: number;
  /** This month's spending against the app's budget. */
  month(): MonthUsage;
  /** The model that sees pictures for this one: the project's own choice, else the settings', else the model itself. */
  vision(conn: Connection, model: string, chosen?: { providerId: string; model: string } | null): Promise<Vision | null>;
  /** Downloads, mail, SSH, dependency audits, before and after of a page (tools/index.ts). */
  toolbox?: ToolboxDeps;
  /** Pointer files to AGENTS.md the settings ask for (CLAUDE.md, GEMINI.md, QWEN.md). */
  /** The project's git rules: the branch before the work, commits on the agent's word, the push at the end. */
  git?: ProjectGit;
  /** The picture tool when the settings name an image model: it draws straight into the project's folder. */
  imageTools?(folder: string, owner: string, hooks: Omit<ToolHooks, "onFinish">, onSpend: (usd: number) => void, budgetLeft: () => number): Promise<ToolSet>;
  /** The run ended (done, paused or stopped): notifications, the sidebar. */
  ended(projectId: string): void;
  /**
   * The conversation as the model had it at the end of the last run, tool calls and results included (asked for: as
   * OpenCode; rebuilt from the saved text, every message started without what the agent had read, and "Go" lost what the
   * plan had read).
   */
  carry?: {
    get(projectId: string): Carried | null;
    set(projectId: string, carried: Carried | null): void;
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * One long run of the agent in a project's conversation (docs/specs/project-work.md). It lives in the core, not in a
 * window's request; the conversation shows how far it got. The model's context goes on from answer to answer: a message
 * from the user ends the current answer after its step, joins the conversation and the next answer takes it into account.
 */
export class WorkRun {
  readonly controller = new AbortController();
  done: Promise<void> = Promise.resolve();
  private readonly inbox: ModelMessage[] = [];
  /** Skills the agent opened in this run (the once-a-task reviews and reminders: repo.rounds). */
  private readonly skillsOpened = new Set<string>();
  /**
   * The start of the system prompt, the same for every answer of this run (asked for: a stable prefix the provider's cache
   * keeps): the time it started and a ready project's map, not computed again for every answer.
   */
  // The day only: the minute changed the start of every message's request, and the whole history went at full price.
  private readonly startedAt = todayLine();
  private map: Promise<string> | null = null;
  /** This turn's answers changed files, so the tester comes before the turn ends (check.ts). */
  private turnChanged = false;
  /** NOTES_DUE was sent in this turn. */
  private notesAsked = false;
  /** Some answer of this turn changed files (turnChanged is cleared once the tester has seen them). */
  private changedAny = false;
  /** How many times this turn went on after "not finished" (GO_ON). */
  private continues = 0;
  /** The folder's snapshot at the turn's first answer. */
  private turnStart: string | null = null;
  /** A release or a deploy waited for the tester this turn (held). */
  private publishHeld = false;
  /** What shortening the conversation cost before the next answer (a summary): counted with that answer. */
  private pendingCost = 0;
  /** Tester rounds in this turn: found, fixed, checked again, at most CHECK_ROUNDS. */
  private checkRounds = 0;
  /** The code reviewer read this turn's changes already (review.ts): once a turn. */
  private reviewed = false;
  /** What the last answer said, for the tester. */
  private lastSaid = "";
  /** At a limit: the agent leaves the code working within a short allowance, then the run stops (NEAR_SHARE, GRACE). */
  private wrapUp: "budget" | "limit" | null = null;
  /** What the run may have spent by the end of wrapping up. */
  private wrapBudget = 0;
  /** The tester found nothing: the agent publishes what it held back, without another check. */
  private publishing = false;
  /** The project's own service model, when it chose one: summaries are written by it. */
  private serviceModel(): { conn: Connection; model: string } | null {
    const service = this.d.extensions?.(this.projectId).service;
    const conn = service ? this.d.providers.connection(service.providerId) : null;
    return service && conn ? { conn, model: service.model } : null;
  }

  /** A command that publishes waits while the tester has yet to try the turn's work (publish.ts). */
  private async held(command: string): Promise<string | null> {
    if (!PUBLISHES.test(command) || this.publishing || !this.testerOn() || this.checkRounds >= CHECK_ROUNDS) return null;
    // Nothing changed since the tester found the work clean: it goes out now.
    const checked = lastChecked(this.folder);
    if (checked && checked === (await treeOf(this.folder).catch(() => null))) return null;
    this.publishHeld = true;
    return HELD;
  }

  private reviewOn(): boolean {
    return this.d.extensions?.(this.projectId).review === true;
  }

  /** The code reviewer's answer in the conversation, its cost with it (review.ts). */
  private async review(conn: Connection, model: string): Promise<ReviewResult | null> {
    const signal = this.controller.signal;
    const answer = this.d.chats.addMessage({ chatId: this.chatId, role: "assistant", content: "", status: "streaming", providerId: conn.id, model });
    const activity: ActivityEntry[] = [{ name: "reviewer", input: "", at: 0 }];
    let content = "";
    const spent = { cost: 0, input: 0, output: 0, cached: 0 };
    const save = () => this.d.chats.saveProgress(answer.id, { content, reasoning: null, activity });
    save();
    const asked = this.d.chats.history(this.chatId).filter((m) => m.role === "user" && !m.content.startsWith("[Drimvox")).at(-1)?.content ?? "";
    const diff = this.turnStart ? await diffSince(this.folder, this.turnStart).catch(() => "") : "";
    const found = await reviewCode(
      {
        conn,
        model,
        price: await findModel(conn, model),
        folder: this.folder,
        signal,
        idleTimeoutMs: this.d.idleTimeoutMs,
        // Within the run's allowance past its limit, as the tester.
        budgetUsd: Math.max(0, this.row().budgetUsd * GRACE - this.spent()),
        hooks: {
          onCall: (call) => {
            activity.push({ name: call.name, input: describeCall(call.input), at: content.length });
            save();
          },
          onResult: () => {},
          askApproval: (() => Promise.resolve(false)) as ToolHooks["askApproval"],
        },
        onSpend: (usd, t) => {
          spent.cost += usd;
          spent.input += t.inputTokens;
          spent.output += t.outputTokens;
          spent.cached += t.cachedTokens;
        },
        onText: (text) => {
          content = content ? `${content}\n\n${text}` : text;
          save();
        },
      },
      { asked, diff },
    );
    if (found) content = [content, found.summary, ...found.issues.map((x, i) => `${i + 1}. ${x.file}: ${x.what}`)].filter(Boolean).join("\n\n");
    this.d.chats.finishAnswer(answer.id, {
      content: content || "—",
      reasoning: null,
      status: signal.aborted ? "stopped" : "done",
      inputTokens: spent.input,
      outputTokens: spent.output,
      cachedTokens: spent.cached,
      contextTokens: null,
      costUsd: spent.cost,
      error: null,
      activity,
    });
    return found;
  }

  private testerOn(): boolean {
    return (this.d.extensions?.(this.projectId).check ?? true) && !!this.d.visualKit;
  }

  constructor(
    private readonly d: RunDeps,
    readonly projectId: string,
    readonly chatId: string,
    private readonly folder: string,
  ) {}

  /** A message the user wrote while the run goes on; it is already in the conversation. */
  post(message: ModelMessage): void {
    this.inbox.push(message);
  }

  start(): void {
    this.done = inConversation(this.chatId, () => this.loop()).catch((err) => {
      this.d.repo.update(this.projectId, { status: "paused", reason: "error", detail: String(err).slice(0, 2000) });
    });
  }

  /** The model working now runs on this computer: no hours limit for it. */
  private localNow(): boolean {
    const row = this.row();
    const ref = row.escalated && row.models?.strong ? row.models.strong : row.models?.work;
    const conn = ref ? this.d.providers.connection(ref.providerId) : null;
    return !!conn && isLocal(conn);
  }

  private row() {
    return this.d.repo.get(this.projectId)!;
  }

  /** The stretch going on now: when it began, the time worked before it, and what its answer has cost so far. */
  private stretch = { since: 0, base: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  /**
   * Time and money including the stretch going on now (seen live: the panel said "0 min, 0 ₽" for minutes, as both were
   * counted only when an answer of many steps ended).
   */
  progress(): { workedMs: number; inFlightUsd: number; inputTokens: number; outputTokens: number; cachedTokens: number } {
    return {
      workedMs: this.stretch.since ? this.stretch.base + (Date.now() - this.stretch.since) : this.row().workedMs,
      inFlightUsd: this.stretch.costUsd,
      inputTokens: this.stretch.inputTokens,
      outputTokens: this.stretch.outputTokens,
      cachedTokens: this.stretch.cachedTokens,
    };
  }

  /** When this run began: the budget and the hours are for one message's work (asked for: a cap that really stops). */
  private runStart = Date.now();

  private spent(): number {
    return this.d.repo.spending(this.chatId, this.runStart).spentUsd;
  }

  private async loop(): Promise<void> {
    const signal = this.controller.signal;
    const chat = this.d.chats.get(this.chatId)!;
    const history = this.d.chats.history(this.chatId);
    const kept = this.d.carry?.get(this.projectId);
    // The last run's whole conversation when only the user's new message came since; the saved text otherwise (a restart,
    // an undone answer, an edited message).
    // Not the conversation another model left (seen live: OmniCoder's 16 thousand tokens fitted Nexus's conversation into a
    // summary, and DeepSeek, with a million, would have gone on from it).
    const model = this.row().models?.work?.model;
    const fresh = kept && kept.chatId === this.chatId && (kept.model === undefined || kept.model === model) && history.length === kept.turns + 1 && history.at(-1)?.role === "user";
    const messages: ModelMessage[] = fresh
      ? [...kept.messages, ...toModelMessages(history.slice(-1), this.d.chats.attachments, true)]
      : toModelMessages(history, this.d.chats.attachments, true);
    let workedBase = this.row().workedMs;
    let since = Date.now();
    const worked = () => workedBase + (Date.now() - since);
    this.stretch = { since, base: workedBase, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let errors = 0;
    // Set after a "too long" refusal: the next answer starts from a shortened conversation (context.ts), once.
    let tooLong = false;
    let overflowTried = false;
    this.runStart = Date.now();
    this.turnChanged = false;
    this.continues = 0;
    this.turnStart = null;
    this.publishHeld = false;
    this.checkRounds = 0;
    this.reviewed = false;
    this.notesAsked = false;
    this.changedAny = false;
    this.publishing = false;
    this.wrapUp = null;
    this.d.repo.update(this.projectId, { status: "running", reason: null, detail: null });
    // The branch the project's git rules ask for, before anything changes.
    await this.d.git?.prepare(this.projectId, this.folder).catch(() => {});
    // A project from before the notes went into AGENTS.md: there they are, for whoever continues.
    try {
      mirrorNotes(this.folder);
    } catch {
      // A folder that cannot be written: the notes stay in Drimvox's data.
    }

    // How the run ended, written after git's last steps: until then it still counts as running (a new message waits).
    let final: {
      status: "paused" | "stopped" | "done";
      reason: "budget" | "time" | "stuck" | "error" | "user" | "month_budget" | null;
      detail: string | null;
      workedMs: number;
    } | null = null;
    const stopWith = (
      status: "paused" | "stopped" | "done",
      reason: "budget" | "time" | "stuck" | "error" | "user" | "month_budget" | null,
      detail?: string,
    ) => {
      final = { status, reason, detail: detail ?? null, workedMs: worked() };
    };

    try {
      for (;;) {
        if (signal.aborted) return stopWith("stopped", "user");
        const row = this.row();
        const ranMs = () => Date.now() - this.runStart;
        // Wrapping up at a limit, the allowance is the answer's own (GRACE_STEPS, wrapBudget): it always gets its chance.
        if (!this.wrapUp && this.spent() >= row.budgetUsd) return stopWith("paused", "budget");
        if (!this.wrapUp && ranMs() >= row.hours * 3_600_000 && !this.localNow()) return stopWith("paused", "time");

        const escalated = row.escalated && row.models?.strong;
        const ref = escalated ? row.models!.strong! : (row.models?.work ?? { providerId: chat.providerId!, model: chat.model! });
        const conn = this.d.providers.connection(ref.providerId);
        if (!conn) return stopWith("paused", "error", "no_provider");
        // The app's budget for the month is used up: the run waits until it is raised.
        if (this.d.month().over && !isFreeToRun(conn)) return stopWith("paused", "month_budget");

        // The whole conversation goes to the model until it nears the model's limit; then old outputs are cut, and if that
        // is not enough the older part becomes a summary (context.ts). The summary's cost goes with the next answer.
        const fitted = await fitContext(
          messages,
          memoryLimit(await findModel(conn, ref.model).catch(() => undefined)),
          (upTo) => remember(conn, ref.model, this.folder, messages, null, upTo, signal, undefined, this.serviceModel()),
          { force: tooLong, thinking: conn.preset !== "anthropic" },
        ).catch(() => null);
        tooLong = false;
        this.pendingCost += fitted?.costUsd ?? 0;
        const outcome = await this.answer(
          messages,
          conn,
          ref.model,
          () => {
            const now = this.row();
            return !this.wrapUp && ranMs() >= now.hours * 3_600_000 && !isLocal(conn);
          },
          // How much of the message's limits is used, and what is left in words, for the reminder near them.
          () => {
            const now = this.row();
            // What finished answers spent, and this one so far.
            const spentNow = this.spent() + this.stretch.costUsd;
            const money = spentNow / now.budgetUsd;
            const time = isLocal(conn) ? 0 : ranMs() / (now.hours * 3_600_000);
            const minutes = Math.max(0, Math.round((now.hours * 3_600_000 - ranMs()) / 60_000));
            return { share: Math.max(money, time), left: `about $${Math.max(0, now.budgetUsd - spentNow).toFixed(2)} and ${minutes} min` };
          },
        );
        this.d.repo.update(this.projectId, { workedMs: worked() });
        workedBase = worked();
        since = Date.now();
        this.stretch = { since, base: workedBase, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        if (signal.aborted || outcome.kind === "stopped") return stopWith("stopped", "user");
        if (outcome.kind === "error") {
          // The provider said the request was too long: shortened once and sent again (as DeepSeek Harness recovers).
          if (outcome.error.code === "too_large" && !overflowTried) {
            overflowTried = tooLong = true;
            continue;
          }
          const wait = retryWait(outcome.error.code, ++errors);
          // Not the same provider again: the router picks another for a while (routing.ts).
          if (TRANSIENT.has(outcome.error.code)) unpinCheapest(conn.baseUrl, ref.model);
          if (wait !== null) {
            await sleep(wait, signal);
            continue;
          }
          // The working model keeps failing: the strong one takes over, when the project has one.
          if (row.models?.strong && !row.escalated) {
            this.d.repo.update(this.projectId, { escalated: true });
            errors = 0;
            continue;
          }
          return stopWith("paused", "error", outcome.error.detail ?? outcome.error.code);
        }
        errors = 0;
        // What the user wrote while the agent worked: in the conversation already, now in the model's context too.
        if (this.inbox.length) {
          messages.push(...this.inbox.splice(0));
          continue;
        }
        // At a limit the first time: a short allowance to leave the code working, not a stop in the middle of an edit.
        if ((outcome.kind === "budget" || outcome.kind === "limit") && !this.wrapUp) {
          this.wrapUp = outcome.kind;
          // A step can overshoot a limit far: the allowance counts from here.
          this.wrapBudget = this.spent() + this.row().budgetUsd * (GRACE - 1);
          messages.push({ role: "user", content: WRAP_UP });
          continue;
        }
        // The allowance is over: the work waits, the limit named, the agent's reply saying what is left.
        if (this.wrapUp) return stopWith("paused", this.wrapUp === "budget" ? "budget" : "time");
        if (outcome.kind === "budget") return stopWith("paused", "budget");
        // A long answer goes on without a pause (asked for: as Claude Code, give the task and get it done), with one word
        // at each 60 steps: if what was asked is done, stop now (seen live: a site fine at 20 rubles, polished on and on).
        if (outcome.kind === "steps") messages.push({ role: "user", content: DONE_YET });
        if (outcome.kind === "limit" || outcome.kind === "steps") continue;
        // It says the work is not done and there is room to go on: it goes on, before any tester tries half the work.
        if (unfinished(this.lastSaid) && this.continues < CONTINUES && !this.publishing && this.spent() < this.row().budgetUsd * NEAR_SHARE && ranMs() < this.row().hours * 3_600_000 * NEAR_SHARE) {
          this.continues++;
          messages.push({ role: "user", content: GO_ON });
          continue;
        }
        // Switched on in the project: a reviewer reads the turn's changes for bugs first, once (asked for, with a switch).
        if (this.turnChanged && !this.reviewed && this.reviewOn() && !this.publishing && this.spent() < this.row().budgetUsd) {
          this.reviewed = true;
          const found = await this.review(conn, ref.model);
          if (signal.aborted) return stopWith("stopped", "user");
          if (found?.issues.length) {
            messages.push({ role: "user", content: reviewMessage(found) });
            continue;
          }
        }
        // The agent says it is done: when the turn changed files, a tester tries it as the user will, and what it finds
        // goes back to the agent (asked for: "why do I find the bugs").
        // Not with the money spent: the tester would only add to it (seen live: $0.25 on a $0.15 budget, no code changed).
        if (this.turnChanged && this.checkRounds < CHECK_ROUNDS && this.testerOn() && !this.publishing && this.spent() < this.row().budgetUsd) {
          this.checkRounds++;
          this.turnChanged = false;
          const found = await this.check(conn, ref.model);
          if (signal.aborted) return stopWith("stopped", "user");
          if (found?.problems.length) {
            messages.push({ role: "user", content: findingsMessage(found) });
            continue;
          }
          // Checked and clean: what the agent held back (a release, a deploy) goes out now, once.
          if (found) {
            const tree = await treeOf(this.folder).catch(() => null);
            if (tree) keepChecked(this.folder, tree);
            messages.push({ role: "user", content: CLEAN_CHECK });
            this.publishing = true;
            continue;
          }
        }
        // A release that waited, in a turn that changed nothing: nothing to check, it goes out now, once.
        if (this.publishHeld && !this.turnChanged && !this.publishing && this.checkRounds === 0) {
          messages.push({ role: "user", content: NOTHING_TO_CHECK });
          this.publishing = true;
          continue;
        }
        // Last, once the work is checked: notes that did not follow a turn's changes are asked for (NOTES_DUE).
        if (this.changedAny && !this.notesAsked && !notesChangedSince(this.folder, this.runStart)) {
          this.notesAsked = true;
          messages.push({ role: "user", content: NOTES_DUE });
          continue;
        }
        // As in a chat: the answer is the end of the turn; the next message goes on.
        return stopWith("done", null);
      }
    } finally {
      // A dev server the agent started does not hold the port once the run is over. In a ready project, talked to as in a
      // chat, it stays between messages (seen live: the agent started the same server three times over).
      const how = (final as { status: string } | null)?.status;
      if (!(how === "done" && !this.row().site)) this.d.visualKit.background.stopAll(this.chatId);
      // And what its commands left running on their own (a server started with &): seen live, ten of them over a day.
      void stopLeftovers(this.folder);
      // The project's state for whoever picks it up next, in Drimvox or another program (AGENTS.md, notes.ts).
      try {
        const row = this.row();
        const goal = this.d.chats.history(this.chatId).find((m) => m.role === "user")?.content ?? "";
        const branch = this.d.git ? ((await this.d.git.state(this.projectId, this.folder).catch(() => null))?.branch ?? null) : null;
        writeState(this.folder, { goal, checklist: [], start: row.site, branch, report: row.report, at: Date.now() });
      } catch {
        // A folder that cannot be written: the state is only in Drimvox.
      }
      // The agent commits itself, with messages of its own (asked for: as OpenCode; Drimvox's commits were named by the
      // user's messages). Its commits go to GitHub, as the rules say.
      if (this.d.git) {
        const asked =
          this.d.chats
            .history(this.chatId)
            .filter((m) => m.role === "user")
            .at(-1)
            ?.content.split("\n")[0] ?? "";
        await this.d.git.finish(this.projectId, this.folder, asked).catch(() => {});
      }
      this.d.carry?.set(this.projectId, { chatId: this.chatId, turns: this.d.chats.history(this.chatId).length, model: this.row().models?.work?.model, messages });
      if (final) this.d.repo.update(this.projectId, final);
      this.d.ended(this.projectId);
    }
  }

  /** One answer in the conversation: up to SEGMENT_STEPS steps of the model and its tools. */
  private async answer(
    messages: ModelMessage[],
    conn: Connection,
    model: string,
    outOfTime: () => boolean,
    used: () => { share: number; left: string } = () => ({ share: 0, left: "" }),
  ): Promise<{ kind: "natural" | "steps" | "budget" | "limit" | "stopped" } | { kind: "error"; error: ProviderError }> {
    const signal = this.controller.signal;
    const answer = this.d.chats.addMessage({ chatId: this.chatId, role: "assistant", content: "", status: "streaming", providerId: conn.id, model });
    // The folder as it was before this answer: "Undo" under it brings it back, as in a chat with a folder (asked for).
    const checkpointRef = `refs/drimvox/chat/${this.chatId}/${answer.id}`;
    const snapshot = await checkpoint(this.folder, checkpointRef).catch(() => null);
    // The folder as the turn found it: what its answers did to the tests is shown to the tester (weakened.ts).
    if (snapshot && !this.turnStart) this.turnStart = snapshot;
    const activity: ActivityEntry[] = [];
    let content = "";
    let input = 0;
    let output = 0;
    let cached = 0;
    // A summary written before this answer is paid with it (context.ts).
    let cost = this.pendingCost;
    this.pendingCost = 0;
    let priced = true;
    let lastStep = 0;
    // The last step called tools: a limit stopped the agent in the middle, not its own end (then it wraps up).
    let midWork = false;
    const save = () => this.d.chats.saveProgress(answer.id, { content, reasoning: null, activity });
    const onCall = (name: string, what: string, stat?: Pick<ActivityEntry, "added" | "removed" | "perFile"> | null) => {
      if (name === "use_skill") this.skillsOpened.add(what);
      activity.push({ name, input: what, at: content.length, ...(stat ?? {}) });
      save();
    };
    // The activity line of a call, and the approvals of risky commands, as in a chat with a folder.
    const emit = async (event: StreamEvent) => {
      if (event.type === "tool") onCall(event.name, event.input);
    };
    const askApproval: ToolHooks["askApproval"] = (command, reason, sig, purpose) =>
      this.d.approvals.ask(this.chatId, emit, { server: "", tool: command, input: null, reason, purpose, signal: sig });
    // A write or an edit carries the lines it adds and removes, counted before it runs.
    const hooks = {
      onCall: (call: { name: string; input: unknown }) => onCall(call.name, describeCall(call.input), lineStat(this.folder, call.name, call.input)),
      // The notes go into the project's AGENTS.md as soon as they change, so the agent's own commit takes them along.
      onResult: (r: { name: string; ok: boolean }) => {
        if (r.name === "update_notes" && r.ok) mirrorNotes(this.folder);
      },
      askApproval,
      held: (command: string) => this.held(command),
    };

    const price = await findModel(conn, model);
    // The project's own skills, the downloaded ones it switched on, its model for screenshots (asked for: per project).
    const chosen = this.d.extensions?.(this.projectId) ?? { skills: null, mcp: null, vision: null, service: null };
    const vision = await this.d.vision(conn, model, chosen.vision);
    // The working model sees pictures itself: its screenshots go into its own conversation, and it looks with all it knows
    // of the task (asked for: "DeepSeek sees, why does another request look for it"). The latest ones only.
    const selfSees = !!vision && vision.conn.id === conn.id && vision.model === model;
    let board: { pictures: Buffer[]; caption: string } | null = null;
    const show = selfSees ? (pictures: Buffer[], caption: string) => void (board = { pictures: pictures.map(fitForModel), caption }) : undefined;
    const serviceConn = chosen.service ? this.d.providers.connection(chosen.service.providerId) : null;
    const service = chosen.service && serviceConn ? { conn: serviceConn, model: chosen.service.model } : null;
    const skills = findSkills([...projectSkillRoots(this.folder), { dir: this.d.skillsDir, scope: "shared" }]).filter(
      (s) => s.scope === "project" || chosen.skills === null || chosen.skills.includes(s.name),
    );
    const files = { list: () => this.d.chats.attachments.ofChat(this.chatId), file: (id: string) => this.d.chats.attachments.file(id) };
    // The user's MCP servers work in the run too (seen: four were switched on and the run had none of them).
    const mcpTools = this.d.mcp
      ? await this.d.mcp.toolsFor(
          (call) => this.d.approvals.ask(this.chatId, emit, call),
          {
            onCall: (call) => onCall(call.name, describeCall(call.input)),
            onResult: () => {},
          },
          (id) => chosen.mcp === null || chosen.mcp.includes(id),
        )
      : {};
    const spentNow = this.spent();
    const gitLine = this.d.git ? await this.d.git.instructions(this.projectId, this.folder) : undefined;
    const imageTools = this.d.imageTools
      ? await this.d.imageTools(
          this.folder,
          this.chatId,
          hooks,
          (usd) => (cost += usd),
          () => this.row().budgetUsd - spentNow - cost,
        )
      : {};
    const own: ToolSet = {
      ...mcpTools,
      ...(this.d.toolbox
        ? toolbox(this.d.toolbox, {
            folder: this.folder,
            vision,
            hooks,
            owner: this.chatId,
            see: show
              ? async (png, question) => (show([png], question), `The picture follows in the conversation. Look at it yourself: ${question}`)
              : vision
                ? async (png, question, signal) => (await askAboutPictures(vision, [{ data: png, mediaType: "image/png" }], question, signal)).text
                : undefined,
          })
        : {}),
      ...imageTools,
      ...pick(folderTools(this.folder, emit, askApproval, files, vision), ["save_attachment", "look_at_image"]),
      ...webTools(
        this.d.web,
        { onCall: (call) => onCall(call.name, describeCall(call.input)) },
        { local: true, vision, onSpend: (usd) => (cost += usd), folder: this.folder, owner: this.chatId },
      ),
      ...skillTools(skills, this.folder, hooks),
      // Research in a fresh context, only its report coming back (asked for: sub-agents as in Claude Code).
      ...subagentTools({
        conn,
        model,
        service,
        price,
        folder: this.folder,
        signal,
        idleTimeoutMs: this.d.idleTimeoutMs,
        tools: () => webTools(this.d.web, { onCall: () => {} }, { local: true, folder: this.folder, owner: this.chatId, onSpend: (usd) => (cost += usd) }),
        onSpend: (usd) => (cost += usd),
        onCall,
      }),
      ...visualTools(
        {
          kit: this.d.visualKit,
          taskId: this.chatId,
          worktree: this.folder,
          vision,
          hooks,
          onSpend: (usd) => (cost += usd),
          event: (kind, data) => {
            this.shot(kind, data);
            // The screenshot goes into the conversation where it was taken (seen: on the right, nobody knew when).
            if (kind === "screenshot") onCall("screenshot", (data as { id: string }).id);
          },
          show,
        },
        LOOKS,
      ),
      // Asking when it must, with answers to pick (asked for: as OpenCode, instead of the interview and plan switches).
      question: tool({
        description:
          "Ask the user when you need a decision only they can make (what they want, a choice between ways that matters) and " +
          "cannot find it in the project or the request. Each question gets 2-4 short answers to pick, the one you " +
          "recommend first; the user may write their own instead. The work waits for the answer. Ask nothing you can " +
          "decide well yourself, and ask all you need in one call.",
        inputSchema: z.object({
          questions: z
            .array(
              z.object({
                question: z.string().min(1).max(500),
                header: z.string().max(40).optional().describe("A very short label, such as \"Голос\" or \"Хранение\""),
                options: z.array(z.object({ label: z.string().min(1).max(100), description: z.string().max(240).optional() })).min(2).max(4),
                multiple: z.boolean().optional().describe("The user may pick several answers"),
              }),
            )
            .min(1)
            .max(4),
        }),
        execute: async ({ questions }, x: { toolCallId: string; abortSignal?: AbortSignal }) => {
          onCall("question", questions.map((q) => q.question).join(" · ").slice(0, 300));
          const answers = await this.d.questions.ask(this.chatId, questions, x.abortSignal ?? signal);
          if (!answers) return "The user did not answer. Go on with what you think best and say what you assumed.";
          const lines = questions.map((q, i) => `${i + 1}. ${q.question} → ${answers[i] ?? answers[0] ?? ""}`);
          return `The user answered:\n${lines.join("\n")}`;
        },
      }),
    };
    // The browser's usual tools go as one (browser/one.ts); its rare ones stay apart, loaded when needed (deferred.ts).
    const tools = oneBrowser(own, Object.keys(own).filter(isRare));
    const spentBefore = this.spent();
    const overBudget = () => spentBefore + cost >= (this.wrapUp ? this.wrapBudget : this.row().budgetUsd);
    let limited = false;
    const outcome = await runAgent({
      service,
      conn,
      model,
      price,
      worktree: this.folder,
      messages,
      mode: "write",
      noFinish: true,
      thinkingLevel: this.row().thinking,
      ownTools: tools,
      // Old outputs leave the conversation (prune.ts); the MCP servers' tools wait until loaded, as the rare ones do.
      prune: true,
      rare: Object.keys(mcpTools),
      maxSteps: this.wrapUp ? GRACE_STEPS : SEGMENT_STEPS,
      remind: () => {
        if (this.wrapUp) return null;
        const now = used();
        return now.share >= NEAR_SHARE ? nearLimit(now.share, now.left) : null;
      },
      // Shown once, with the step right after: as a person glances at the screen and goes on (and the steps after keep the
      // provider's cache).
      pictures: () => {
        const once = board;
        board = null;
        return once;
      },
      stopWhen: () => {
        limited = outOfTime();
        return this.inbox.length > 0 || limited || overBudget();
      },
      // As a chat with a folder says it (asked for: that loop made the better site for half the money): the folder, the
      // language, the format; no long rules of design, checks, notes and git.
      // Short as OpenCode's (agent-prompt.ts): the folder, the tone, how to do a task and stop; no rules of design.
      system: [
        this.startedAt,
        agentPrompt(this.folder, process.platform, gitLine, this.testerOn() && !this.publishing),
        LANGUAGE_HINT,
        HONEST_HINT,
        DATA_HINT,
        FACTS_HINT,
        // What goes through the user's proxy and what does not (seen live: 18 commands spent on the network).
        proxyHint(this.d.web),
        TOOLS_NOTE,
        this.d.toolbox ? sshNote(this.d.toolbox.ssh) : "",
        skillsInstructions(skills),
        // A ready project's files and what each defines (as Aider's repo map): fewer steps spent finding the right file.
        await (this.map ??= projectMap(this.folder).catch(() => "")),
      ]
        .filter(Boolean)
        .join("\n\n"),
      spentUsd: 0,
      budgetUsd: Number.POSITIVE_INFINITY,
      signal,
      idleTimeoutMs: this.d.idleTimeoutMs,
      hooks,
      onText: (text) => {
        content = content ? `${content}\n\n${text}` : text;
        save();
      },
      onStep: (step) => {
        messages.push(...step.messages);
        midWork = step.messages.some((m) => m.role === "tool");
        input += step.inputTokens;
        output += step.outputTokens;
        cached += step.cachedTokens;
        cost += step.costUsd;
        this.stretch.costUsd = cost;
        this.stretch.inputTokens = input;
        this.stretch.outputTokens = output;
        this.stretch.cachedTokens = cached;
        // What this step sent is what the model holds now: the context bar.
        if (step.inputTokens) this.d.repo.update(this.projectId, { contextTokens: step.inputTokens });
        lastStep = step.inputTokens + step.outputTokens || lastStep;
        if (!step.priced) priced = false;
      },
    });
    // What the model was billed at (asked for: the rates of reading, the cache and writing): the provider its requests
    // were pinned to behind a router, else the catalog's prices.
    const pinned = pinnedRates(conn.baseUrl, model);
    const perUnit = pinned && conn.currency === "RUB" ? 1 / (await usdRub().catch(() => 0)) : 1;
    const rates =
      pinned && Number.isFinite(perUnit)
        ? { input: pinned.input * 1e6 * perUnit, cached: pinned.cached * 1e6 * perUnit, output: pinned.output * 1e6 * perUnit }
        : price && price.priceIn !== null && price.priceOut !== null
          ? { input: price.priceIn, cached: price.priceCacheRead ?? price.priceIn, output: price.priceOut }
          : null;
    if (rates) this.d.repo.update(this.projectId, { rates });
    const stopped = outcome.kind === "stopped";
    const error = outcome.kind === "error" ? outcome.error : null;
    // From here the answer's cost is in its message: not counted twice.
    this.stretch.costUsd = 0;
    this.stretch.inputTokens = 0;
    this.stretch.outputTokens = 0;
    this.stretch.cachedTokens = 0;
    if (snapshot) {
      const changed = await changedSince(this.folder, snapshot).catch(() => false);
      // The tester comes after a turn whose answers changed files (check.ts).
      if (changed) this.turnChanged = true;
      if (changed) this.changedAny = true;
      if (changed) this.d.chats.setCheckpoint(answer.id, snapshot);
      else await dropCheckpoint(this.folder, checkpointRef).catch(() => {});
    }
    this.lastSaid = content;
    this.d.chats.finishAnswer(answer.id, {
      content,
      reasoning: null,
      status: stopped ? "stopped" : error ? "error" : "done",
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      contextTokens: lastStep || null,
      costUsd: priced || cost > 0 ? cost : null,
      error,
      activity,
    });
    if (stopped) return { kind: "stopped" };
    if (error) return { kind: "error", error };
    if (outcome.kind === "steps") return { kind: "steps" };
    // Its own end, though past a limit at it: nothing to wrap up.
    if (!midWork) return { kind: "natural" };
    if (overBudget()) return { kind: "budget" };
    if (limited) return { kind: "limit" };
    return { kind: "natural" };
  }

  /**
   * The tester's turn (check.ts): its own answer in the conversation, its actions in the feed, its report as the words;
   * the same working model with a fresh context, only hands and eyes, nothing that changes the project or a server.
   */
  private async check(conn: Connection, model: string): Promise<CheckResult | null> {
    const signal = this.controller.signal;
    const answer = this.d.chats.addMessage({ chatId: this.chatId, role: "assistant", content: "", status: "streaming", providerId: conn.id, model });
    const activity: ActivityEntry[] = [];
    let content = "";
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    const save = () => this.d.chats.saveProgress(answer.id, { content, reasoning: null, activity });
    const onCall = (name: string, what: string) => {
      activity.push({ name, input: what, at: content.length });
      save();
    };
    const emit = async (event: StreamEvent) => {
      if (event.type === "tool") onCall(event.name, event.input);
    };
    const hooks = {
      onCall: (call: { name: string; input: unknown }) => onCall(call.name, describeCall(call.input)),
      onResult: () => {},
      askApproval: ((command, reason, sig, purpose) =>
        this.d.approvals.ask(this.chatId, emit, { server: "", tool: command, input: null, reason, purpose, signal: sig })) as ToolHooks["askApproval"],
    };
    // Its first line says whose answer this is.
    onCall("tester", "");
    const price = await findModel(conn, model);
    const chosen = this.d.extensions?.(this.projectId) ?? { skills: null, mcp: null, vision: null, service: null };
    const vision = await this.d.vision(conn, model, chosen.vision);
    const selfSees = !!vision && vision.conn.id === conn.id && vision.model === model;
    let board: { pictures: Buffer[]; caption: string } | null = null;
    const show = selfSees ? (pictures: Buffer[], caption: string) => void (board = { pictures: pictures.map(fitForModel), caption }) : undefined;
    const see = show
      ? async (png: Buffer, question: string) => (show([png], question), `The picture follows in the conversation. Look at it yourself: ${question}`)
      : vision
        ? async (png: Buffer, question: string, sig?: AbortSignal) => (await askAboutPictures(vision, [{ data: png, mediaType: "image/png" }], question, sig)).text
        : undefined;
    // Hands and eyes only: no servers over SSH, no mail, no downloads into the project, no pictures drawn.
    const hands = this.d.toolbox
      ? Object.fromEntries(
          Object.entries(toolbox(this.d.toolbox, { folder: this.folder, vision, hooks, owner: `${this.chatId}:check`, see })).filter(([name]) => !/^(ssh_|email_|downloads_)/.test(name)),
        )
      : {};
    const own: ToolSet = {
      ...hands,
      ...visualTools(
        {
          kit: this.d.visualKit,
          taskId: `${this.chatId}:check`,
          worktree: this.folder,
          vision,
          hooks,
          onSpend: (usd) => (cost += usd),
          event: (kind, data) => {
            this.shot(kind, data);
            if (kind === "screenshot") onCall("screenshot", (data as { id: string }).id);
          },
          show,
        },
        LOOKS,
      ),
    };
    const asked =
      this.d.chats
        .history(this.chatId)
        .filter((m) => m.role === "user" && !m.content.startsWith("[Drimvox's tester"))
        .at(-1)?.content ?? "";
    // What the turn changed: the tests that lost checks and the screens to look at go to the tester.
    const turnDiff = this.turnStart ? await diffSince(this.folder, this.turnStart).catch(() => "") : "";
    const found = await checkWork(
      {
        conn,
        model,
        price,
        // Up to the allowance past the limit, as the agent's own wrap-up; then it reports what it saw.
        budgetUsd: Math.max(0, this.row().budgetUsd * GRACE - this.spent()),
        folder: this.folder,
        signal,
        idleTimeoutMs: this.d.idleTimeoutMs,
        tools: oneBrowser(own, Object.keys(own).filter(isRare)),
        pictures: () => {
          const once = board;
          board = null;
          return once;
        },
        hooks,
        onSpend: (usd, t) => {
          cost += usd;
          input += t.inputTokens;
          output += t.outputTokens;
          cached += t.cachedTokens;
        },
        onText: (text) => {
          content = content ? `${content}\n\n${text}` : text;
          save();
        },
      },
      { asked, said: this.lastSaid, notes: notesBlock(this.folder), tests: weakenedNote(weakenedTests(turnDiff)), screens: changedScreens(turnDiff), recipe: readRecipe(this.folder), packaged: packagedNote(electronApp(this.folder), turnDiff) },
    );
    // What it started is stopped: the agent's own servers stay as they were.
    this.d.visualKit.background.stopAll(`${this.chatId}:check`);
    // How it started the project, for the next tester (tester-memory.ts).
    keepRecipe(this.folder, found?.start);
    if (found) {
      const list = found.problems.map((p, i) => `${i + 1}. ${p.what}`).join("\n");
      content = [content, found.summary, list].filter(Boolean).join("\n\n");
    }
    this.d.chats.finishAnswer(answer.id, {
      content: content || "—",
      reasoning: null,
      status: signal.aborted ? "stopped" : "done",
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      contextTokens: null,
      costUsd: cost,
      error: null,
      activity,
    });
    return found;
  }

  /** Screenshots the agent took are kept for the panel next to the conversation. */
  private shot(kind: string, data: unknown): void {
    if (kind !== "screenshot") return;
    const s = data as { id: string; url: string };
    this.d.repo.update(this.projectId, { shots: [...this.row().shots, { id: s.id, url: s.url, at: Date.now() }] });
  }
}

/** What the web and the browser are for, in a line, instead of the chats' long rules of searching and browsing. */
const TOOLS_NOTE =
  "You have web_search and open_page for documentation and current facts, and a real browser (the browser tool) to open " +
  "pages and go through them as a person would. Never solve captchas or bot checks yourself.";

/** A run's whole conversation kept for the next one (RunDeps.carry). */
export interface Carried {
  chatId: string;
  /** How many turns the chat's saved history had when it was kept. */
  turns: number;
  /** The model it was fitted for: another one (another window) starts from the saved messages. */
  model?: string;
  messages: ModelMessage[];
}

/** Only the named tools of a set, those it has. */
function pick(tools: ToolSet, names: string[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => names.includes(name)));
}
