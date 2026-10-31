import { defaultGitRules, projectGitRulesSchema, type ProjectGitRules, type ProjectGitState } from "@drimvox/shared";
import { anywhere, currentBranch, NEVER_ADDED, runGit } from "../agent/git";
import type { Database } from "../db";
import type { GitHub } from "../github/github";

/** Files that never go into the agent's commits: keys and passwords stay out of git (and so out of GitHub). */
const SECRETS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "*.keystore"];
const identity = ["-c", "user.name=Drimvox", "-c", "user.email=drimvox@localhost"];

interface Kept {
  /** The agent's branch and the one it came from. */
  branch: string;
  base: string;
  pullRequest: { number: number; url: string } | null;
}

const rulesKey = (projectId: string) => `git.rules:${projectId}`;
const keptKey = (projectId: string) => `git.branch:${projectId}`;

/**
 * The agent's git in a project, by the project's rules (docs/specs/project-git.md, asked for: the agent works with git on
 * its own — a branch, commits, a pull request — and the user accepts or rejects). Drimvox itself switches branches,
 * commits (secrets and dependencies left out), pushes and opens the pull request; the agent only says when and what.
 */
export class ProjectGit {
  constructor(
    private readonly db: Database,
    private readonly github: GitHub,
  ) {}

  rules(projectId: string): ProjectGitRules {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(rulesKey(projectId)) as { value: string } | undefined;
    if (!row) return defaultGitRules;
    const parsed = projectGitRulesSchema.safeParse({ ...defaultGitRules, ...(JSON.parse(row.value) as object) });
    return parsed.success ? parsed.data : defaultGitRules;
  }

  setRules(projectId: string, rules: ProjectGitRules): ProjectGitRules {
    this.put(rulesKey(projectId), rules);
    return rules;
  }

  private kept(projectId: string): Kept | null {
    const row = this.db.sql.prepare("select value from settings where key = ?").get(keptKey(projectId)) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Kept) : null;
  }

  private keep(projectId: string, kept: Kept | null): void {
    if (kept) this.put(keptKey(projectId), kept);
    else this.db.sql.prepare("delete from settings where key = ?").run(keptKey(projectId));
  }

  private put(key: string, value: unknown): void {
    this.db.sql.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, JSON.stringify(value));
  }

  /**
   * Before the agent works: the branch the rules ask for. A branch of the agent's own that is still open is kept (the
   * next message goes on in it); otherwise a new one starts from where the folder is.
   */
  async prepare(projectId: string, folder: string): Promise<void> {
    const rules = this.rules(projectId);
    if (rules.commit === "never" || rules.target === "current") return;
    const here = await currentBranch(folder);
    if (!here) return;
    const kept = this.kept(projectId);
    if (kept && kept.branch === here) return;
    const main = await mainBranch(folder);
    if (rules.target === "main" && rules.allowMain) {
      if (main && here !== main) await runGit(folder, ["switch", main], true);
      return;
    }
    const branch = rules.target === "work-branch" ? "drimvox/work" : `drimvox/task-${stamp()}`;
    const exists = (await runGit(folder, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], true)).code === 0;
    const switched = await runGit(folder, exists ? ["switch", branch] : ["switch", "-c", branch], true);
    if (switched.code === 0) this.keep(projectId, { branch, base: kept?.branch === branch ? kept.base : here, pullRequest: null });
  }

  /** What the agent did so far, as one commit; false when there was nothing to commit or the rules say not to. */
  async commit(projectId: string, folder: string, message: string): Promise<boolean> {
    if (this.rules(projectId).commit === "never") return false;
    const tracked = (await runGit(folder, ["ls-files", "--", ...NEVER_ADDED.map(anywhere)], true)).stdout.split("\n").filter(Boolean).map((p) => p.split("/"));
    const skipped = NEVER_ADDED.filter((name) => !tracked.some((parts) => parts.includes(name)));
    const add = await runGit(folder, ["add", "-A", "--", ".", ...skipped.map((n) => `:(exclude,glob)**/${n}/**`), ...SECRETS.map((s) => `:(exclude,glob)**/${s}`)], true);
    if (add.code !== 0) return false;
    if ((await runGit(folder, ["diff", "--cached", "--quiet"], true)).code === 0) return false;
    const text = message.trim().split("\n")[0]!.slice(0, 200) || "Work by Drimvox";
    return (await runGit(folder, [...identity, "commit", "-q", "--no-verify", "-m", text], true)).code === 0;
  }

  /** After the agent's work: its branch to GitHub, and the pull request, as the rules say. */
  async finish(projectId: string, folder: string, title: string): Promise<void> {
    const rules = this.rules(projectId);
    const kept = this.kept(projectId);
    if (!kept || !rules.push || (await currentBranch(folder)) !== kept.branch || !(await this.github.ready(folder))) return;
    try {
      await this.github.push(folder);
      if (rules.pullRequest && !kept.pullRequest && (await ahead(folder, kept.base)) > 0) {
        const pr = await this.github.pullRequest(folder, kept.branch, kept.base, title.slice(0, 120) || kept.branch, "Made by the agent in Drimvox.");
        this.keep(projectId, { ...kept, pullRequest: pr });
      }
    } catch {
      // Shown as not sent: the branch stays here and goes the next time.
    }
  }

  async state(projectId: string, folder: string): Promise<ProjectGitState> {
    const branch = await currentBranch(folder);
    const kept = this.kept(projectId);
    const mine = kept && kept.branch === branch ? kept : null;
    return {
      branch,
      base: mine?.base ?? null,
      ahead: mine ? await ahead(folder, mine.base) : 0,
      github: await this.github.ready(folder).catch(() => false),
      pullRequest: mine?.pullRequest ?? null,
    };
  }

  /** "Accept": the agent's branch goes into its base here (and to GitHub when pushing, which closes the pull request). */
  async accept(projectId: string, folder: string): Promise<boolean> {
    const kept = this.kept(projectId);
    if (!kept) return false;
    await this.commit(projectId, folder, "Work by Drimvox");
    if ((await runGit(folder, ["switch", kept.base], true)).code !== 0) return false;
    const merged = await runGit(folder, [...identity, "merge", "--no-ff", "--no-edit", kept.branch], true);
    if (merged.code !== 0) {
      await runGit(folder, ["merge", "--abort"], true);
      await runGit(folder, ["switch", kept.branch], true);
      return false;
    }
    this.keep(projectId, null);
    if (this.rules(projectId).push && (await this.github.ready(folder))) await this.github.push(folder).catch(() => {});
    return true;
  }

  /** "Reject": back to the base branch; the agent's branch stays as it is, its pull request is closed. */
  async reject(projectId: string, folder: string): Promise<boolean> {
    const kept = this.kept(projectId);
    if (!kept) return false;
    await this.commit(projectId, folder, "Work by Drimvox");
    if ((await runGit(folder, ["switch", kept.base], true)).code !== 0) return false;
    if (kept.pullRequest) await this.github.closePullRequest(folder, kept.pullRequest.number).catch(() => {});
    this.keep(projectId, null);
    return true;
  }

  /** What the agent is told about committing, by the rules; the project's recent messages when it writes like them. */
  async instructions(projectId: string, folder: string): Promise<string> {
    const rules = this.rules(projectId);
    if (rules.commit === "never") return "- Never commit or push: git stays the user's.";
    const when = {
      "per-item": "after each checklist item you finish, call commit_changes with a message for that step",
      end: "when the whole task is done, call commit_changes once with a message for it",
      logical: "call commit_changes at logical points, each commit one meaningful change",
      never: "",
    }[rules.commit];
    let style = {
      history: "",
      en: "Commit messages: one short line in English, imperative (Fix cart total after removing an item).",
      ru: "Commit messages: one short line in Russian (Исправлен пересчёт суммы в корзине).",
      conventional: "Commit messages: Conventional Commits, one line (fix(cart): recalc total on remove).",
    }[rules.messages];
    if (rules.messages === "history") {
      const log = (await runGit(folder, ["log", "-8", "--format=%s"], true)).stdout.trim();
      style = log ? `Commit messages: write them like this project's recent ones:\n${log}` : "Commit messages: one short line in English, imperative.";
    }
    return [
      `- Git: ${when}. Drimvox makes the commit (secrets and dependency folders are left out), pushes and opens the pull`,
      "  request itself. Never run git commit, push, checkout, switch or reset yourself.",
      `- ${style}`,
    ].join("\n");
  }
}

/** The repository's main branch: main or master, whichever exists. */
async function mainBranch(folder: string): Promise<string | null> {
  for (const name of ["main", "master"]) if ((await runGit(folder, ["rev-parse", "--verify", "-q", `refs/heads/${name}`], true)).code === 0) return name;
  return null;
}

async function ahead(folder: string, base: string): Promise<number> {
  const res = await runGit(folder, ["rev-list", "--count", `${base}..HEAD`], true);
  return res.code === 0 ? Number(res.stdout.trim()) || 0 : 0;
}

/** A branch name's date part: month, day, hours and minutes. */
function stamp(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}
