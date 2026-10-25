import type { ActivityEntry, ChecklistItem, MonthUsage, ProjectPlan, ProviderError, StreamEvent } from "@drimvox/shared";
import type { ModelMessage, ToolSet } from "ai";
import { runAgent } from "../agent/run";
import { isFreeToRun } from "../budget";
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
import { findSkills, projectSkillRoots, skillsInstructions, skillTools } from "../skills/skills";
import type { Vision } from "../visual/look";
import { VISUAL_HINT, visualTools, type VisualKit } from "../visual/tools";
import { nudgeMessage, projectRules } from "./prompt";
import type { ProjectWorkRepo } from "./repo";
import { workTools } from "./tools";

/** Steps one answer of the run takes before the next answer goes on with the same context. */
export const SEGMENT_STEPS = 60;
/** Times in a row the model may stop without finish_work, and without ticking anything off, before it counts as stuck. */
export const MAX_NUDGES = 3;
/** Actions without touching the checklist before the agent is reminded of it (seen live: unticked for an hour and a half). */
export const CHECKLIST_EVERY = 25;
const CHECKLIST_NOTE = "Tick off in the checklist what is done by now with update_checklist, then go on.";
/** Provider errors in a row before the run stops and waits. */
const MAX_ERRORS = 2;
const RETRY_MS = 5000;
/** Looks at pages per answer: the desktop and the phone, scenarios, and again after fixes. */
const LOOKS = { looks: 8, then: "You have looked at pages enough in this answer: go on with the work, you can look again in the next one." };

export interface RunDeps {
  chats: ChatRepo;
  providers: ProviderRepo;
  approvals: ChatApprovals;
  repo: ProjectWorkRepo;
  visualKit: VisualKit;
  web: WebAccess;
  skillsDir: string;
  idleTimeoutMs: number;
  plan(projectId: string): ProjectPlan | null;
  /** This month's spending against the app's budget. */
  month(): MonthUsage;
  vision(conn: Connection, model: string): Promise<Vision | null>;
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
  /** Actions since the checklist was last updated. */
  private sinceChecklist = 0;

  constructor(
    private readonly d: RunDeps,
    readonly projectId: string,
    readonly chatId: string,
    private readonly folder: string,
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

  private row() {
    return this.d.repo.get(this.projectId)!;
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
    let nudges = 0;
    let errors = 0;
    let doneBefore = this.row().checklist.filter((i) => i.done).length;
    this.d.repo.update(this.projectId, { status: "running", reason: null, detail: null });

    const stopWith = (status: "paused" | "stopped" | "done", reason: "budget" | "time" | "stuck" | "error" | "user" | "month_budget" | null, detail?: string) => {
      this.d.repo.update(this.projectId, { status, reason, detail: detail ?? null, workedMs: worked() });
    };

    try {
      for (;;) {
        if (signal.aborted) return stopWith("stopped", "user");
        const row = this.row();
        if (this.spent() >= row.budgetUsd) return stopWith("paused", "budget");
        if (worked() >= row.hours * 3_600_000) return stopWith("paused", "time");

        const escalated = row.escalated && row.models?.strong;
        const ref = escalated ? row.models!.strong! : (row.models?.work ?? { providerId: chat.providerId!, model: chat.model! });
        const conn = this.d.providers.connection(ref.providerId);
        if (!conn) return stopWith("paused", "error", "no_provider");
        // The app's budget for the month is used up: the run waits until it is raised.
        if (this.d.month().over && !isFreeToRun(conn)) return stopWith("paused", "month_budget");

        const outcome = await this.answer(messages, conn, ref.model, () => {
          const now = this.row();
          return worked() >= now.hours * 3_600_000;
        });
        this.d.repo.update(this.projectId, { workedMs: worked() });
        workedBase = worked();
        since = Date.now();
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
      // A dev server the agent started does not hold the port once the run is over.
      this.d.visualKit.background.stopAll(this.chatId);
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
    const activity: ActivityEntry[] = [];
    let content = "";
    let input = 0;
    let output = 0;
    let cost = 0;
    let priced = true;
    const save = () => this.d.chats.saveProgress(answer.id, { content, reasoning: null, activity });
    const onCall = (name: string, what: string) => {
      this.sinceChecklist = name === "update_checklist" ? 0 : this.sinceChecklist + 1;
      activity.push({ name, input: what, at: content.length });
      save();
    };
    // The activity line of a call, and the approvals of risky commands, as in a chat with a folder.
    const emit = async (event: StreamEvent) => {
      if (event.type === "tool") onCall(event.name, event.input);
    };
    const askApproval: ToolHooks["askApproval"] = (command, reason, sig, purpose) =>
      this.d.approvals.ask(this.chatId, emit, { server: "", tool: command, input: null, reason, purpose, signal: sig });
    const hooks = { onCall: (call: { name: string; input: unknown }) => onCall(call.name, describeCall(call.input)), onResult: () => {}, askApproval };

    const price = await findModel(conn, model);
    const plan = this.d.plan(this.projectId);
    const vision = await this.d.vision(conn, model);
    const skills = findSkills([...projectSkillRoots(this.folder), { dir: this.d.skillsDir, scope: "shared" }]);
    const files = { list: () => this.d.chats.attachments.ofChat(this.chatId), file: (id: string) => this.d.chats.attachments.file(id) };
    const own: ToolSet = {
      ...pick(folderTools(this.folder, emit, askApproval, files, vision), ["save_attachment", "look_at_image"]),
      ...webTools(this.d.web, { onCall: (call) => onCall(call.name, describeCall(call.input)) }),
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
        onCall,
      }),
    };
    const spentBefore = this.spent();
    const overBudget = () => spentBefore + cost >= this.row().budgetUsd;
    let limited = false;
    const outcome = await runAgent({
      conn,
      model,
      price,
      worktree: this.folder,
      messages,
      mode: "write",
      noFinish: true,
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
        projectRules(plan, !!vision && !!this.d.visualKit.screenshot),
        VISUAL_HINT,
        WEB_HINT,
        skillsInstructions(skills),
      ]
        .filter(Boolean)
        .join("\n\n"),
      spentUsd: 0,
      budgetUsd: Number.POSITIVE_INFINITY,
      signal,
      idleTimeoutMs: conn.preset === "ollama" || conn.preset === "lmstudio" ? Math.max(this.d.idleTimeoutMs, 600_000) : this.d.idleTimeoutMs,
      hooks,
      onText: (text) => {
        content = content ? `${content}\n\n${text}` : text;
        save();
      },
      onStep: (step) => {
        messages.push(...step.messages);
        input += step.inputTokens;
        output += step.outputTokens;
        cost += step.costUsd;
        if (!step.priced) priced = false;
      },
    });
    const stopped = outcome.kind === "stopped";
    const error = outcome.kind === "error" ? outcome.error : null;
    this.d.chats.finishAnswer(answer.id, {
      content,
      reasoning: null,
      status: stopped ? "stopped" : error ? "error" : "done",
      inputTokens: input,
      outputTokens: output,
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
