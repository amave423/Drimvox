import { gitCommitModes, gitMessageStyles, gitTargets, type ProjectGitRules, type ProjectGitState, type ProjectView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { Toggle } from "../Toggle";

/**
 * How the agent works with git in this project (docs/specs/project-git.md, asked for: the variant "rules for the agent"
 * without manual commits): where it writes, when it commits, how its messages read; and its branch to accept or reject.
 */
export function ProjectGitCard({ project, busy }: { project: ProjectView; busy: boolean }) {
  const { api, t } = useApp();
  const [rules, setRules] = useState<ProjectGitRules | null>(null);
  const [state, setState] = useState<ProjectGitState | null>(null);
  const [failed, setFailed] = useState(false);
  const [working, setWorking] = useState(false);

  async function load() {
    const view = await api.projects[":id"].git
      .$get({ param: { id: project.id } })
      .then((r) => ok<{ rules: ProjectGitRules; state: ProjectGitState }>(r))
      .catch(() => null);
    if (view) {
      setRules(view.rules);
      setState(view.state);
    }
  }
  // The branch moves while the agent works: looked at again when the run stops.
  useEffect(() => void load(), [project.id, busy]);

  async function save(patch: Partial<ProjectGitRules>) {
    if (!rules) return;
    const next = { ...rules, ...patch };
    setRules(next);
    await api.projects[":id"].git.rules.$put({ param: { id: project.id }, json: next }).catch(() => null);
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
    <label className="field">
      <span>{t(label)}</span>
      <select className="field-input" value={rules[key]} onChange={(e) => void save({ [key]: e.target.value } as Partial<ProjectGitRules>)}>
        {values.map((v) => (
          <option key={v} value={v}>
            {t(`git.${key}.${v}` as MessageKey)}
          </option>
        ))}
      </select>
    </label>
  );
  const off = rules.commit === "never";

  return (
    <>
      <section className="card git-rules" aria-label={t("git.title")}>
        <h3 className="card-h">{t("git.title")}</h3>
        {select("target", gitTargets, "git.target")}
        {select("commit", gitCommitModes, "git.commit")}
        {select("messages", gitMessageStyles, "git.messages")}
        <Toggle checked={rules.push} disabled={off} onChange={(push) => void save({ push })}>
          {t("git.push")}
        </Toggle>
        <Toggle checked={rules.pullRequest} disabled={off || !rules.push} onChange={(pullRequest) => void save({ pullRequest })}>
          {t("git.pullRequest")}
        </Toggle>
        <Toggle checked={rules.allowMain} disabled={off} onChange={(allowMain) => void save({ allowMain })}>
          {t("git.allowMain")}
        </Toggle>
        {!off && rules.push && state && !state.github && <p className="muted git-note">{t("git.noGithub")}</p>}
      </section>
      {state?.base && state.branch && (
        <section className="card git-branch" aria-label={t("git.branchTitle")}>
          <h3 className="card-h">{state.pullRequest ? t("git.pr", { n: state.pullRequest.number }) : t("git.branchTitle")}</h3>
          <p className="muted">
            <span className="mono">
              {state.branch} → {state.base}
            </span>{" "}
            · {t("git.ahead", { n: state.ahead })}
          </p>
          <div className="actions">
            <button className="btn is-primary" disabled={busy || working} onClick={() => void settle("accept")}>
              {t("git.accept")}
            </button>
            {state.pullRequest && (
              <a className="btn" href={state.pullRequest.url} target="_blank" rel="noreferrer">
                {t("git.openPr")}
              </a>
            )}
            <button className="btn is-pencil" disabled={busy || working} onClick={() => void settle("reject")}>
              {t("git.reject")}
            </button>
          </div>
          {failed && <p className="error-note">{t("git.failed")}</p>}
        </section>
      )}
    </>
  );
}
