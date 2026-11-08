import type { ActivityEntry, MonthUsage, ProjectPlan, ProviderError, StreamEvent } from "@drimvox/shared";
import type { McpAsk, McpHooks } from "../mcp/hub";
import { compactHistory } from "./compact";
import type { ModelMessage, ToolSet } from "ai";
import { runAgent } from "../agent/run";
import { isFreeToRun, isLocal } from "../budget";
import type { ToolHooks } from "../agent/tools";
import type { ChatApprovals } from "../chats/approvals";
import { describeCall, folderTools } from "../chats/folder";
import { toModelMessages } from "../chats/history";
import type { ChatRepo } from "../chats/repo";
import { webTools } from "../internet/tools";
import type { WebAccess } from "../internet/web";
import { nowLine } from "../now";
import { findModel } from "../providers/catalog";
import type { Connection, ProviderRepo } from "../providers/repo";
import { findSkills, projectSkillRoots, skillsInstructions, skillTools } from "../skills/skills";
import { askAboutPictures, type Vision } from "../visual/look";
import { visualTools, type VisualKit } from "../visual/tools";
import type { ProjectGit } from "./project-git";
import { changedSince, checkpoint, dropCheckpoint } from "../chats/checkpoint";
import { writeState } from "../agent/notes";
import { toolbox, type ToolboxDeps } from "../tools";
import { sshNote } from "../tools/ssh";
import { memoryLimit, sizeOf, TRIM_SHARE } from "../agent/memory";
import type { ProjectWorkRepo } from "./repo";
import { projectMap } from "../agent/repo-map";
import { proxyHint } from "../internet/blocked";
import { lineStat } from "./line-stat";
import { subagentTools } from "../agent/subagent";
import { LANGUAGE_HINT } from "../chats/reply";
import { planModeInstructions, planModeTools } from "./plan-mode";
import { agentPrompt } from "./agent-prompt";

/** Steps one answer of the run takes before the next answer goes on with the same context. */
export const SEGMENT_STEPS = 60;
/** Drimvox's word to a project worked as a chat, at every 60 steps of one answer. */
export const DONE_YET =
  "[Drimvox: 60 steps on this message.] If what the user asked is done and nothing is broken, stop now and reply what you made. Otherwise go on with what is left, without polishing what already works.";
/** Provider errors in a row before the run stops and waits. */
const MAX_ERRORS = 2;
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
  mcp?: { toolsFor(ask: McpAsk, hooks: McpHooks, only?: (serverId: string) => boolean): Promise<ToolSet> };
  /** The downloaded skills and the MCP servers this project switched on; null in either: all of them. */
  extensions?(projectId: string): {
    skills: string[] | null;
    mcp: string[] | null;
    vision: { providerId: string; model: string } | null;
    service: { providerId: string; model: string } | null;
  };
  idleTimeoutMs: number;
  plan(projectId: string): ProjectPlan | null;
  /** Keeps the plan the plan mode proposed (plan-mode.ts). */
  setPlan(projectId: string, plan: ProjectPlan): void;
  /** This month's spending against the app's budget. */
  month(): MonthUsage;
  /** The model that sees pictures for this one: the project's own choice, else the settings', else the model itself. */
  vision(conn: Connection, model: string, chosen?: { providerId: string; model: string } | null): Promise<Vision | null>;
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
  private readonly inbox: string[] = [];
  private finished = false;
  /** Skills the agent opened in this run (the once-a-task reviews and reminders: repo.rounds). */
  private readonly skillsOpened = new Set<string>();
  /**
   * The start of the system prompt, the same for every answer of this run (asked for: a stable prefix the provider's cache
   * keeps): the time it started and a ready project's map, not computed again for every answer.
   */
  private readonly startedAt = nowLine();
  private map: Promise<string> | null = null;

  constructor(
    private readonly d: RunDeps,
    readonly projectId: string,
    readonly chatId: string,
    private readonly folder: string,
    /**
     * "plan": the plan as Claude Code makes it, reading only, ending with propose_plan (plan-mode.ts); "work": the work
     * itself, as in a chat with a folder (asked for: that loop made the better site, for half the money).
     */
    private readonly mode: "work" | "plan" = "work",
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
    const fresh = kept && kept.chatId === this.chatId && history.length === kept.turns + 1 && history.at(-1)?.role === "user";
    const messages: ModelMessage[] = fresh
      ? [...kept.messages, ...toModelMessages(history.slice(-1), this.d.chats.attachments, true)]
      : toModelMessages(history, this.d.chats.attachments, true);
    let workedBase = this.row().workedMs;
    let since = Date.now();
    const worked = () => workedBase + (Date.now() - since);
    this.stretch = { since, base: workedBase, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let errors = 0;
    this.runStart = Date.now();
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
        const ranMs = () => Date.now() - this.runStart;
        if (this.spent() >= row.budgetUsd) return stopWith("paused", "budget");
        if (ranMs() >= row.hours * 3_600_000 && !this.localNow()) return stopWith("paused", "time");

        const escalated = row.escalated && row.models?.strong;
        const ref = escalated ? row.models!.strong! : (row.models?.work ?? { providerId: chat.providerId!, model: chat.model! });
        const conn = this.d.providers.connection(ref.providerId);
        if (!conn) return stopWith("paused", "error", "no_provider");
        // The app's budget for the month is used up: the run waits until it is raised.
        if (this.d.month().over && !isFreeToRun(conn)) return stopWith("paused", "month_budget");

        // The older part of a long run is shortened between answers only half way to the model's limit (asked for: as
        // OpenCode; trimmed every time, the agent read the same files again and again).
        if (sizeOf(messages) > memoryLimit(await findModel(conn, ref.model).catch(() => undefined)) * TRIM_SHARE) compactHistory(messages);
        const outcome = await this.answer(messages, conn, ref.model, () => {
          const now = this.row();
          return ranMs() >= now.hours * 3_600_000 && !isLocal(conn);
        });
        this.d.repo.update(this.projectId, { workedMs: worked() });
        workedBase = worked();
        since = Date.now();
        this.stretch = { since, base: workedBase, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        if (signal.aborted || outcome.kind === "stopped") return stopWith("stopped", "user");
        if (this.finished) return stopWith("done", null);
        if (outcome.kind === "error") {
          if (++errors < MAX_ERRORS) {
            await sleep(RETRY_MS, signal);
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
          for (const text of this.inbox.splice(0)) messages.push({ role: "user", content: text });
          continue;
        }
        if (outcome.kind === "budget") return stopWith("paused", "budget");
        // A long answer goes on without a pause (asked for: as Claude Code, give the task and get it done), with one word
        // at each 60 steps: if what was asked is done, stop now (seen live: a site fine at 20 rubles, polished on and on).
        if (outcome.kind === "steps") messages.push({ role: "user", content: DONE_YET });
        if (outcome.kind === "limit" || outcome.kind === "steps") continue;
        // As in a chat: the answer is the end of the turn; the next message goes on.
        return stopWith("done", null);
      }
    } finally {
      // A dev server the agent started does not hold the port once the run is over. In a ready project, talked to as in a
      // chat, it stays between messages (seen live: the agent started the same server three times over).
      const how = (final as { status: string } | null)?.status;
      if (!(how === "done" && !this.row().site)) this.d.visualKit.background.stopAll(this.chatId);
      // The project's state for whoever picks it up next, in Drimvox or another program (AGENTS.md, notes.ts).
      try {
        const row = this.row();
        const goal = this.d.plan(this.projectId)?.context ?? this.d.chats.history(this.chatId).find((m) => m.role === "user")?.content ?? "";
        const branch = this.d.git ? ((await this.d.git.state(this.projectId, this.folder).catch(() => null))?.branch ?? null) : null;
        if (this.mode === "work")
          writeState(this.folder, { goal, checklist: [], start: row.site, branch, report: row.report, at: Date.now() }, this.d.agentFiles?.() ?? []);
      } catch {
        // A folder that cannot be written: the state is only in Drimvox.
      }
      // What the agent left uncommitted goes in one commit; then its branch to GitHub, as the rules say.
      if (this.d.git && this.mode === "work") {
        const asked =
          this.d.chats
            .history(this.chatId)
            .filter((m) => m.role === "user")
            .at(-1)
            ?.content.split("\n")[0] ?? "";
        await this.d.git.commit(this.projectId, this.folder, asked).catch(() => false);
        await this.d.git.finish(this.projectId, this.folder, asked).catch(() => {});
      }
      this.d.carry?.set(this.projectId, { chatId: this.chatId, turns: this.d.chats.history(this.chatId).length, messages });
      if (final)
        this.d.repo.update(
          this.projectId,
          this.finished && this.mode === "plan" && (final as { status: string }).status === "done" ? { ...(final as object), status: "ready" } : final,
        );
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
      onResult: () => {},
      askApproval,
    };

    const price = await findModel(conn, model);
    const plan = this.d.plan(this.projectId);
    // The project's own skills, the downloaded ones it switched on, its model for screenshots (asked for: per project).
    const chosen = this.d.extensions?.(this.projectId) ?? { skills: null, mcp: null, vision: null, service: null };
    const vision = await this.d.vision(conn, model, chosen.vision);
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
        },
        LOOKS,
      ),
      ...(this.mode === "plan"
        ? planModeTools((proposed: ProjectPlan) => {
            this.finished = true;
            this.d.setPlan(this.projectId, proposed);
          })
        : {}),
    };
    // The plan mode only reads: the project, the web, sub-agents, skills; no writing, no commands, no browser yet.
    const tools: ToolSet = this.mode === "plan" ? pick(own, ["delegate", "use_skill", "read_skill_file", "web_search", "open_page", "propose_plan"]) : own;
    const spentBefore = this.spent();
    const overBudget = () => spentBefore + cost >= this.row().budgetUsd;
    let limited = false;
    const outcome = await runAgent({
      service,
      conn,
      model,
      price,
      worktree: this.folder,
      messages,
      mode: this.mode === "plan" ? "read" : "write",
      noFinish: true,
      thinkingLevel: this.row().thinking,
      ownTools: tools,
      stopTools: ["propose_plan"],
      maxSteps: SEGMENT_STEPS,
      stopWhen: () => {
        limited = outOfTime();
        return this.inbox.length > 0 || limited || overBudget();
      },
      // As a chat with a folder says it (asked for: that loop made the better site for half the money): the folder, the
      // language, the format; no long rules of design, checks, notes and git.
      // Short as OpenCode's (agent-prompt.ts): the folder, the tone, how to do a task and stop; no rules of design.
      system: [
        this.startedAt,
        agentPrompt(this.folder),
        LANGUAGE_HINT,
        // What goes through the user's proxy and what does not (seen live: 18 commands spent on the network).
        proxyHint(this.d.web),
        TOOLS_NOTE,
        this.d.toolbox ? sshNote(this.d.toolbox.ssh) : "",
        skillsInstructions(skills),
        // A ready project's files and what each defines (as Aider's repo map): fewer steps spent finding the right file.
        await (this.map ??= projectMap(this.folder).catch(() => "")),
        this.mode === "plan" ? planModeInstructions(this.d.repo.phase(this.projectId).interview) : "",
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

/** What the web and the browser are for, in a line, instead of the chats' long rules of searching and browsing. */
const TOOLS_NOTE =
  "You have web_search and open_page for documentation and current facts, and a real browser (browser_open, browser_look " +
  "and the other browser_ tools) to open pages, the project's own too. Never solve captchas or bot checks yourself.";

/** A run's whole conversation kept for the next one (RunDeps.carry). */
export interface Carried {
  chatId: string;
  /** How many turns the chat's saved history had when it was kept. */
  turns: number;
  messages: ModelMessage[];
}

/** Only the named tools of a set, those it has. */
function pick(tools: ToolSet, names: string[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => names.includes(name)));
}
