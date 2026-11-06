import { gitCommitModes, gitMessageStyles, gitTargets, type ProjectGitRules, type ProjectGitState, type ProjectView } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { Dropdown } from "../Dropdown";
import { Toggle } from "../Toggle";

/**
 * How the agent works with git in this project (docs/specs/project-git.md): where its branch is, how far GitHub has it,
 * its pull request; folded below, the rules — where it writes, when it commits, how its messages read. Commits and
 * pushes go by themselves (asked for: no accepting or sending by hand, no duplicates).
 */
export function ProjectGitCard({ project, busy }: { project: ProjectView; busy: boolean }) {
  const { api, t } = useApp();
  const [rules, setRules] = useState<ProjectGitRules | null>(null);
  const [state, setState] = useState<ProjectGitState | null>(null);
  const [failed, setFailed] = useState(false);
  const [working, setWorking] = useState(false);
  /** Changes the user made: a look started before the latest one must not bring the old rules back. */
  const edits = useRef(0);

  async function load() {
    const seen = edits.current;
    const view = await api.projects[":id"].git
      .$get({ param: { id: project.id } })
      .then((r) => ok<{ rules: ProjectGitRules; state: ProjectGitState }>(r))
      .catch(() => null);
    if (view) {
      // Seen: the run stopped while a rule was being picked, and the look started then put the old rule back.
      if (edits.current === seen) setRules(view.rules);
      setState(view.state);
    }
  }
  // The branch moves while the agent works: looked at again when the run stops.
  useEffect(() => void load(), [project.id, busy]);

  async function save(patch: Partial<ProjectGitRules>) {
    if (!rules) return;
    const next = { ...rules, ...patch };
    edits.current++;
    setRules(next);
    await api.projects[":id"].git.rules.$put({ param: { id: project.id }, json: next }).catch(() => null);
  }

  /** Sends what GitHub has not got yet (it goes by itself after each answer; this is for when that failed). */
  async function send() {
    setWorking(true);
    setFailed(false);
    const res = await api.github.projects[":id"].push.$post({ param: { id: project.id } }).catch(() => null);
    setWorking(false);
    if (!res?.ok) setFailed(true);
    await load();
  }

  async function settle(action: "accept" | "reject") {
    setWorking(true);
    setFailed(false);
    const res = await api.projects[":id"].git[action].$post({ param: { id: project.id } }).catch(() => null);
    setWorking(false);
    if (!res?.ok) setFailed(true);
    await load();
  }

  if (!rules) return null;
  const select = <K extends "target" | "commit" | "messages">(key: K, values: readonly ProjectGitRules[K][], label: MessageKey) => (
    <div className="field">
      <span>{t(label)}</span>
      <Dropdown<ProjectGitRules[K]>
        label={t(label)}
        value={rules[key]}
        options={values.map((v) => ({ value: v, label: t(`git.${key}.${v}` as MessageKey) }))}
        onChange={(v) => void save({ [key]: v } as Partial<ProjectGitRules>)}
      />
    </div>
  );
  const off = rules.commit === "never";

  return (
    <div className="git-block">
      {/* One line for where the work is (asked for: the branch and GitHub's push were two cards saying the same). */}
      {state?.branch && (
        <div className="git-state" aria-label={t("git.branchTitle")}>
          <p>
            <span className="mono">{state.base ? `${state.branch} → ${state.base}` : state.branch}</span>
            {state.base ? ` · ${t("git.ahead", { n: state.ahead })}` : ""}
          </p>
          {state.author && <p className="muted">{t("git.author", { name: state.author })}</p>}
          {state.github ? (
            <p className={state.unsent ? "is-pencil-text" : "muted"}>
              {state.unsent ? t("git.unsent", { n: state.unsent }) : t("git.sent")}
              {state.pullRequest && (
                <>
                  {" · "}
                  <a href={state.pullRequest.url} target="_blank" rel="noreferrer">
                    {t("git.pr", { n: state.pullRequest.number })}
                  </a>
                </>
              )}
            </p>
          ) : (
            state.base && <p className="muted">{t("git.noGithub")}</p>
          )}
          <div className="actions">
            {state.github && state.unsent > 0 && (
              <button className="btn" disabled={busy || working} onClick={() => void send()}>
                {t("git.sendNow")}
              </button>
            )}
            {/* Without GitHub there is no pull request to merge: the branch goes into its base here. */}
            {!state.github && state.base && state.ahead > 0 && (
              <button className="btn" disabled={busy || working} onClick={() => void settle("accept")}>
                {t("git.mergeHere", { base: state.base })}
              </button>
            )}
          </div>
          {failed && <p className="error-note">{t("git.failed")}</p>}
        </div>
      )}
      <details className="git-rules">
        <summary>{t("git.title")}</summary>
        {select("target", gitTargets, "git.target")}
        {select("commit", gitCommitModes, "git.commit")}
        {select("messages", gitMessageStyles, "git.messages")}
        <Toggle checked={rules.push} disabled={off} onChange={(push) => void save({ push })}>
          {t("git.push")}
        </Toggle>
        <Toggle checked={rules.pullRequest} disabled={off || !rules.push} onChange={(pullRequest) => void save({ pullRequest })}>
          {t("git.pullRequest")}
        </Toggle>
      </details>
    </div>
  );
}
