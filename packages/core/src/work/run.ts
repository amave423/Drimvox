import type { ActivityEntry, ChecklistItem, MonthUsage, ProjectPlan, ProviderError, StreamEvent } from "@drimvox/shared";
import type { McpAsk, McpHooks } from "../mcp/hub";
import { isStaticSite, reviewProjectCode, reviewWorkMessage } from "./code-review";
import { compactHistory } from "./compact";
import type { ModelMessage, ToolSet } from "ai";
import { runAgent } from "../agent/run";
import { isFreeToRun, isLocal } from "../budget";
import type { ToolHooks } from "../agent/tools";
import type { ChatApprovals } from "../chats/approvals";
import { describeCall, folderHint, folderTools } from "../chats/folder";
import { toModelMessages } from "../chats/history";
import type { ChatRepo } from "../chats/repo";
import { WEB_HINT, webTools } from "../internet/tools";
import type { WebAccess } from "../internet/web";
import { nowLine } from "../now";
import { findModel } from "../providers/catalog";
import type { Connection, ProviderRepo } from "../providers/repo";
import { findSkills, projectSkillRoots, skillsGiven, skillsInstructions, skillTools } from "../skills/skills";
import { askAboutPictures, type Vision } from "../visual/look";
import { VISUAL_HINT, visualTools, type VisualKit } from "../visual/tools";
import { existingRules, nudgeMessage, projectRules } from "./prompt";
import type { ProjectGit } from "./project-git";
import { changedSince, checkpoint, dropCheckpoint } from "../chats/checkpoint";
import { writeState } from "../agent/notes";
import { toolbox, type ToolboxDeps } from "../tools";
import { missingMotion, polishWorkMessage, reviewProjectDesign } from "./design-review";
import type { ProjectWorkRepo } from "./repo";
import { workTools } from "./tools";
import { projectMap } from "../agent/repo-map";
import { proxyHint } from "../internet/blocked";
import { checksFailedMessage, checksReport, projectChecks, runChecks } from "./checks";
import { lineStat } from "./line-stat";

/** Steps one answer of the run takes before the next answer goes on with the same context. */
export const SEGMENT_STEPS = 60;
/** Times in a row the model may stop without finish_work, and without ticking anything off, before it counts as stuck. */
export const MAX_NUDGES = 3;
/** Actions without touching the checklist before the agent is reminded of it (seen live: unticked for an hour and a half). */
export const CHECKLIST_EVERY = 25;
const CHECKLIST_NOTE = "Tick off in the checklist what is done by now with update_checklist, then go on.";
/** Provider errors in a row before the run stops and waits. */
const MAX_ERRORS = 2;
/** Times a failing test run sends the agent back before the report says it fails. */
const MAX_CHECK_ROUNDS = 2;
const RETRY_MS = 5000;
/** Looks at pages per answer: the desktop and the phone, scenarios, and again after fixes. */
const LOOKS = {
  looks: 8,
  then: "You have looked at pages enough in this answer: go on with the work, you can look again in the next one, or use browser_look. Never install Playwright or write screenshot scripts.",
};

export interface RunDeps {
  chats: ChatRepo;
  providers: ProviderRepo;
  approvals: ChatApprovals;
  repo: ProjectWorkRepo;
  visualKit: VisualKit;
  web: WebAccess;
  skillsDir: string;
  /** Tools of the user's MCP servers; their questions come into the project's conversation. */
  mcp?: { toolsFor(ask: McpAsk, hooks: McpHooks): Promise<ToolSet> };
  idleTimeoutMs: number;
  plan(projectId: string): ProjectPlan | null;
  /** This month's spending against the app's budget. */
  month(): MonthUsage;
  vision(conn: Connection, model: string): Promise<Vision | null>;
  /** Downloads, mail, SSH, dependency audits, before and after of a page (tools/index.ts). */
  toolbox?: ToolboxDeps;
  /** Pointer files to AGENTS.md the settings ask for (CLAUDE.md, GEMINI.md, QWEN.md). */
  agentFiles?(): string[];
  /** The project's git rules: the branch before the work, commits on the agent's word, the push at the end. */
  git?: ProjectGit;
  /** The picture tool when the settings name an image model: it draws straight into the project's folder. */
  imageTools?(folder: string, owner: string, hooks: Omit<ToolHooks, "onFinish">, onSpend: (usd: number) => void, budgetLeft: () => number): Promise<ToolSet>;
  /** The run ended (done, paused or stopped): notifications, the sidebar. */
  ended(projectId: string): void;
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
  private readonly inbox: string[] = [];
  private finished = false;
  /** Drimvox looked at the result's design in this run: one round of polish at most. */
  /** Skills the agent opened in this run, and whether it was reminded of the others before finishing. */
  private readonly skillsOpened = new Set<string>();
  private skillsNudged = false;
  /** Whether the code was reviewed in this run: once, before it is done. */
  private codeReviewed = false;
  private designReviewed = false;
  /** How many times Drimvox's own run of the project's tests sent the agent back. */
  private checkRounds = 0;
  /** The tests just sent the agent back from finish_work: the run goes on even in a ready project. */
  private sentBack = false;
  /** Actions since the checklist was last updated. */
  private sinceChecklist = 0;

  constructor(
    private readonly d: RunDeps,
    readonly projectId: string,
    readonly chatId: string,
    private readonly folder: string,
    /** A ready project, worked on as in a chat: an answer may end without finish_work, no limits but the month's. */
    private readonly chatMode = false,
  ) {}

  /** A message the user wrote while the run goes on; it is already in the conversation. */
  post(content: string): void {
    this.inbox.push(content);
  }

  start(): void {
    this.done = this.loop().catch((err) => {
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

  private spent(): number {
    const row = this.row();
    return this.d.repo.spending(this.chatId, row.startedAt ?? 0).spentUsd;
  }

  private async loop(): Promise<void> {
    const signal = this.controller.signal;
    const chat = this.d.chats.get(this.chatId)!;
    const messages: ModelMessage[] = toModelMessages(this.d.chats.history(this.chatId), this.d.chats.attachments, true);
    let workedBase = this.row().workedMs;
    let since = Date.now();
    const worked = () => workedBase + (Date.now() - since);
    this.stretch = { since, base: workedBase, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let nudges = 0;
    let errors = 0;
    let doneBefore = this.row().checklist.filter((i) => i.done).length;
    this.d.repo.update(this.projectId, { status: "running", reason: null, detail: null });
    // The branch the project's git rules ask for, before anything changes.
    await this.d.git?.prepare(this.projectId, this.folder).catch(() => {});

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
        if (!this.chatMode && this.spent() >= row.budgetUsd) return stopWith("paused", "budget");
        if (!this.chatMode && worked() >= row.hours * 3_600_000 && !this.localNow()) return stopWith("paused", "time");

        const escalated = row.escalated && row.models?.strong;
        const ref = escalated ? row.models!.strong! : (row.models?.work ?? { providerId: chat.providerId!, model: chat.model! });
        const conn = this.d.providers.connection(ref.providerId);
        if (!conn) return stopWith("paused", "error", "no_provider");
        // The app's budget for the month is used up: the run waits until it is raised.
        if (this.d.month().over && !isFreeToRun(conn)) return stopWith("paused", "month_budget");

        // The older part of a long run is shortened between answers: old outputs and written files, not the words.
        compactHistory(messages);
        const outcome = await this.answer(messages, conn, ref.model, () => {
          const now = this.row();
          return !this.chatMode && worked() >= now.hours * 3_600_000 && !isLocal(conn);
        });
        this.d.repo.update(this.projectId, { workedMs: worked() });
        workedBase = worked();
        since = Date.now();
        this.stretch = { since, base: workedBase, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        if (signal.aborted || outcome.kind === "stopped") return stopWith("stopped", "user");
        if (this.finished) return stopWith("done", null);
        if (outcome.kind === "error") {
          if (++errors >= MAX_ERRORS) return stopWith("paused", "error", outcome.error.detail ?? outcome.error.code);
          await sleep(RETRY_MS, signal);
          continue;
        }
        errors = 0;
        // What the user wrote while the agent worked: in the conversation already, now in the model's context too.
        if (this.inbox.length) {
          for (const text of this.inbox.splice(0)) messages.push({ role: "user", content: text });
          nudges = 0;
          continue;
        }
        if (outcome.kind === "budget") return stopWith("paused", "budget");
        if (outcome.kind === "limit" || outcome.kind === "steps") continue;
        // As in a chat: the answer is the end of the turn; the next message goes on. Unless the project's own tests sent
        // the agent back from finish_work: it fixes them first.
        if (this.chatMode && !this.sentBack) return stopWith("done", null);
        this.sentBack = false;

        // The model stopped on its own without finish_work: remind it, unless it keeps stopping without progress.
        const checklist = this.row().checklist;
        const doneNow = checklist.filter((i) => i.done).length;
        if (doneNow > doneBefore) nudges = 0;
        doneBefore = doneNow;
        if (++nudges <= MAX_NUDGES) {
          messages.push({ role: "user", content: nudgeMessage(checklist.filter((i) => !i.done).map((i) => i.text)) });
          continue;
        }
        if (row.models?.strong && !row.escalated) {
          this.d.repo.update(this.projectId, { escalated: true });
          nudges = 0;
          messages.push({
            role: "user",
            content: `A stronger model takes over the work now. ${nudgeMessage(checklist.filter((i) => !i.done).map((i) => i.text))}`,
          });
          continue;
        }
        return stopWith("paused", "stuck");
      }
    } finally {
      // A dev server the agent started does not hold the port once the run is over. In a ready project, talked to as in a
      // chat, it stays between messages (seen live: the agent started the same server three times over).
      const how = (final as { status: string } | null)?.status;
      if (!(this.chatMode && how === "done" && !this.row().site)) this.d.visualKit.background.stopAll(this.chatId);
      // The project's state for whoever picks it up next, in Drimvox or another program (AGENTS.md, notes.ts).
      try {
        const row = this.row();
        const goal = this.d.plan(this.projectId)?.context ?? this.d.chats.history(this.chatId).find((m) => m.role === "user")?.content ?? "";
        const branch = this.d.git ? ((await this.d.git.state(this.projectId, this.folder).catch(() => null))?.branch ?? null) : null;
        writeState(this.folder, { goal, checklist: row.checklist, start: row.site, branch, report: row.report, at: Date.now() }, this.d.agentFiles?.() ?? []);
      } catch {
        // A folder that cannot be written: the state is only in Drimvox.
      }
      // What the agent left uncommitted goes in one commit; then its branch to GitHub, as the rules say.
      if (this.d.git) {
        const done = this.row()
          .checklist.filter((i) => i.done)
          .at(-1)?.text;
        const asked =
          this.d.chats
            .history(this.chatId)
            .filter((m) => m.role === "user")
            .at(-1)
            ?.content.split("\n")[0] ?? "";
        await this.d.git.commit(this.projectId, this.folder, done ?? asked).catch(() => false);
        await this.d.git.finish(this.projectId, this.folder, asked || done || "").catch(() => {});
      }
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
  ): Promise<{ kind: "natural" | "steps" | "budget" | "limit" | "stopped" } | { kind: "error"; error: ProviderError }> {
    const signal = this.controller.signal;
    const answer = this.d.chats.addMessage({ chatId: this.chatId, role: "assistant", content: "", status: "streaming", providerId: conn.id, model });
    // The folder as it was before this answer: "Undo" under it brings it back, as in a chat with a folder (asked for).
    const checkpointRef = `refs/drimvox/chat/${this.chatId}/${answer.id}`;
    const snapshot = await checkpoint(this.folder, checkpointRef).catch(() => null);
    const activity: ActivityEntry[] = [];
    let content = "";
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let priced = true;
    const save = () => this.d.chats.saveProgress(answer.id, { content, reasoning: null, activity });
    const onCall = (name: string, what: string, stat?: { added: number; removed: number } | null) => {
      if (name === "use_skill") this.skillsOpened.add(what);
      this.sinceChecklist = name === "update_checklist" ? 0 : this.sinceChecklist + 1;
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
      onResult: () => {},
      askApproval,
    };

    const price = await findModel(conn, model);
    const plan = this.d.plan(this.projectId);
    const vision = await this.d.vision(conn, model);
    const skills = findSkills([...projectSkillRoots(this.folder), { dir: this.d.skillsDir, scope: "shared" }]);
    const files = { list: () => this.d.chats.attachments.ofChat(this.chatId), file: (id: string) => this.d.chats.attachments.file(id) };
    // The user's MCP servers work in the run too (seen: four were switched on and the run had none of them).
    const mcpTools = this.d.mcp
      ? await this.d.mcp.toolsFor((call) => this.d.approvals.ask(this.chatId, emit, call), {
          onCall: (call) => onCall(call.name, describeCall(call.input)),
          onResult: () => {},
        })
      : {};
    const spentNow = this.spent();
    const gitLine = this.d.git ? await this.d.git.instructions(this.projectId, this.folder) : undefined;
    const imageTools = this.d.imageTools
      ? await this.d.imageTools(
          this.folder,
          this.chatId,
          hooks,
          (usd) => (cost += usd),
          () => (this.chatMode ? Number.POSITIVE_INFINITY : this.row().budgetUsd - spentNow - cost),
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
            see: vision
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
        },
        LOOKS,
      ),
      ...workTools({
        checklist: () => this.row().checklist,
        setChecklist: (items: ChecklistItem[]) => this.d.repo.update(this.projectId, { checklist: items }),
        ask: (question, assumption) => this.d.repo.update(this.projectId, { questions: [...this.row().questions, { question, assumption, at: Date.now() }] }),
        finish: (report, start) => {
          this.finished = true;
          this.d.repo.update(this.projectId, { report, site: start });
        },
        checks: async () => {
          const commands = projectChecks(this.folder, plan);
          if (!commands.length) return null;
          onCall("run_checks", commands.join("; "));
          const results = await runChecks(this.folder, commands, this.controller.signal);
          this.checkRounds++;
          // Twice back to the agent at most; then the report says honestly what still fails.
          if (results.some((r) => !r.ok) && this.checkRounds <= MAX_CHECK_ROUNDS) {
            this.sentBack = true;
            return { fix: checksFailedMessage(results) };
          }
          const asked =
            this.d.chats
              .history(this.chatId)
              .filter((m) => m.role === "user")
              .at(-1)?.content ??
            plan?.context ??
            "";
          return { report: checksReport(results, /[а-яё]/i.test(asked)) };
        },
        codeReview: async () => {
          if (this.codeReviewed || this.chatMode) return null;
          this.codeReviewed = true;
          // A static page has nothing to attack: no server, no accounts, no one's data.
          if (isStaticSite(this.folder)) return null;
          // The working model reviews, in a fresh conversation with only this to do (asked for: no expensive model for it).
          const row = this.row();
          const ref = row.models?.work ?? null;
          const reviewer = ref ? this.d.providers.connection(ref.providerId) : null;
          if (!ref || !reviewer) return null;
          onCall("code_review", ref.model);
          const issues = await reviewProjectCode({
            conn: reviewer,
            model: ref.model,
            price: await findModel(reviewer, ref.model),
            folder: this.folder,
            plan,
            skills,
            ownTools: pick(own, ["start_background", "read_background", "stop_background"]),
            signal: this.controller.signal,
            idleTimeoutMs: this.d.idleTimeoutMs,
            hooks,
            onSpend: (usd) => (cost += usd),
          }).catch(() => null);
          return issues ? reviewWorkMessage(issues) : null;
        },
        skillsLeft: () => {
          if (this.skillsNudged || this.chatMode) return null;
          this.skillsNudged = true;
          const left = skills.filter((s) => !this.skillsOpened.has(s.name));
          if (!left.length) return null;
          return [
            "Before you finish: these skills are ready and you have not opened them.",
            ...left.map((s) => `- ${s.name}: ${s.description}`),
            "If one is meant for this moment (checking the work before you say it is done, say), open it with use_skill and follow it. Then call finish_work again.",
          ].join("\n");
        },
        review: async (start) => {
          if (this.designReviewed || this.chatMode) return null;
          this.designReviewed = true;
          // Motion asked for is checked in the code: screenshots cannot see it (seen live: "animated" came out still).
          const asked = [plan?.context ?? "", this.d.chats.history(this.chatId).find((m) => m.role === "user")?.content ?? ""].join("\n");
          const motion = missingMotion(this.folder, asked);
          if (!vision || !this.d.visualKit.screenshot) return motion ? polishWorkMessage([motion]) : null;
          onCall("design_review", "");
          const issues = await reviewProjectDesign(
            {
              kit: this.d.visualKit,
              vision,
              owner: this.chatId,
              folder: this.folder,
              plan,
              signal: this.controller.signal,
              onShot: (id, url, width) => {
                this.shot("screenshot", { id, url, width });
                onCall("screenshot", id);
              },
              onSpend: (usd) => (cost += usd),
            },
            start,
          );
          const all = [...(issues ?? []), ...(motion ? [motion] : [])];
          return all.length ? polishWorkMessage(all) : null;
        },
        onCall,
        ...(this.d.git && this.d.git.rules(this.projectId).commit !== "never"
          ? { commit: (message: string) => this.d.git!.commit(this.projectId, this.folder, message) }
          : {}),
      }),
    };
    const spentBefore = this.spent();
    const overBudget = () => !this.chatMode && spentBefore + cost >= this.row().budgetUsd;
    let limited = false;
    const outcome = await runAgent({
      conn,
      model,
      price,
      worktree: this.folder,
      messages,
      mode: "write",
      noFinish: true,
      thinkingLevel: this.row().thinking,
      ownTools: own,
      stopTools: ["finish_work"],
      maxSteps: SEGMENT_STEPS,
      remind: () => {
        if (this.sinceChecklist < CHECKLIST_EVERY) return null;
        this.sinceChecklist = 0;
        return CHECKLIST_NOTE;
      },
      stopWhen: () => {
        limited = outOfTime();
        return this.inbox.length > 0 || limited || overBudget();
      },
      system: [
        nowLine(),
        folderHint(this.folder),
        // What goes through the user's proxy and what does not (seen live: 18 commands spent on the network).
        proxyHint(this.d.web),
        this.chatMode
          ? existingRules(!!vision && !!this.d.visualKit.screenshot, gitLine)
          : projectRules(plan, !!vision && !!this.d.visualKit.screenshot, gitLine),
        VISUAL_HINT,
        WEB_HINT,
        skillsInstructions(skills),
        // The skills the plan was made with, whole: the working model follows them without having to open them.
        this.chatMode ? "" : skillsGiven(skills, plan?.skills ?? []),
        // A ready project's files and what each defines (as Aider's repo map): fewer steps spent finding the right file.
        this.chatMode ? await projectMap(this.folder).catch(() => "") : "",
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
        if (!step.priced) priced = false;
      },
    });
    const stopped = outcome.kind === "stopped";
    const error = outcome.kind === "error" ? outcome.error : null;
    // From here the answer's cost is in its message: not counted twice.
    this.stretch.costUsd = 0;
    this.stretch.inputTokens = 0;
    this.stretch.outputTokens = 0;
    this.stretch.cachedTokens = 0;
    if (snapshot) {
      if (await changedSince(this.folder, snapshot).catch(() => false)) this.d.chats.setCheckpoint(answer.id, snapshot);
      else await dropCheckpoint(this.folder, checkpointRef).catch(() => {});
    }
    this.d.chats.finishAnswer(answer.id, {
      content,
      reasoning: null,
      status: stopped ? "stopped" : error ? "error" : "done",
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      costUsd: priced || cost > 0 ? cost : null,
      error,
      activity,
    });
    if (stopped) return { kind: "stopped" };
    if (error) return { kind: "error", error };
    if (outcome.kind === "steps") return { kind: "steps" };
    if (overBudget()) return { kind: "budget" };
    if (limited) return { kind: "limit" };
    return { kind: "natural" };
  }

  /** Screenshots the agent took are kept for the panel next to the conversation. */
  private shot(kind: string, data: unknown): void {
    if (kind !== "screenshot") return;
    const s = data as { id: string; url: string };
    this.d.repo.update(this.projectId, { shots: [...this.row().shots, { id: s.id, url: s.url, at: Date.now() }] });
  }
}

/** Only the named tools of a set, those it has. */
function pick(tools: ToolSet, names: string[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => names.includes(name)));
}
