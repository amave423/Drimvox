import type { GithubProject, GithubStatus, ProjectView } from "@artel/shared";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { Toggle } from "../Toggle";

/** GitHub turns a folder name with spaces or Cyrillic into dashes anyway: Drimvox offers what it will be. */
function repoName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

/**
 * Publishing the project on GitHub: signing in with a code, then creating the repository and pushing, each only
 * after the user confirms. See docs/specs/github-publish.md.
 */
export function GithubPublish({ project }: { project: ProjectView }) {
  const { api, t } = useApp();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repo, setRepo] = useState<GithubProject | null>(null);
  const [name, setName] = useState(() => repoName(project.name));
  const [isPrivate, setPrivate] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string; detail?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      api.github.$get().then((res) => res.json()),
      api.github.projects[":id"].$get({ param: { id: project.id } }).then((res) => (res.ok ? (res.json() as Promise<GithubProject>) : null)),
    ]).catch(() => [null, null] as const);
    setStatus(s);
    setRepo(r);
  }, [api, project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the user enters the code at GitHub, look every two seconds whether it is done.
  useEffect(() => {
    if (!status?.pending) return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [status?.pending, load]);

  async function login() {
    setProblem(null);
    setStatus(await api.github.login.$post().then((r) => r.json()));
  }

  async function disconnect() {
    await api.github.$delete().catch(() => null);
    await load();
  }

  async function run(action: "publish" | "push") {
    setBusy(true);
    setProblem(null);
    const res =
      action === "publish"
        ? await api.github.projects[":id"].publish.$post({ param: { id: project.id }, json: { name, private: isPrivate } }).catch(() => null)
        : await api.github.projects[":id"].push.$post({ param: { id: project.id } }).catch(() => null);
    setBusy(false);
    setConfirm(false);
    const body = (await res?.json().catch(() => null)) as { url?: string; error?: { code: string; detail?: string } } | null;
    if (res?.ok) {
      setDone(action === "publish" ? (body?.url ?? null) : "pushed");
      await load();
      return;
    }
    setProblem(body?.error ?? { code: "github_error" });
    await load();
  }

  if (!status) return null;
  const errorText = problem && (
    <p className="error-note">
      {t(`github.error.${problem.code}` as MessageKey)}
      {problem.code === "push_failed" && problem.detail && <span className="mono github-detail">{problem.detail}</span>}
    </p>
  );

  return (
    <section className="github" aria-labelledby="github-h">
      <h2 className="sheet-h" id="github-h">
        {t("github.title")}
      </h2>

      {!status.user && !status.pending && (
        <>
          <p className="muted">{t("github.why")}</p>
          {status.error && <p className="error-note">{t(`github.login.${status.error}`)}</p>}
          <button className="btn" onClick={() => void login()}>
            {t("github.connect")}
          </button>
        </>
      )}

      {status.pending && (
        <div className="github-code">
          <p>{t("github.enterCode")}</p>
          <code className="mono github-user-code" aria-label={t("github.code")}>
            {status.pending.userCode}
          </code>
          <div className="actions">
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(status.pending!.userCode)}>
              {t("code.copy")}
            </button>
            <a className="btn is-primary" href={status.pending.verificationUri} target="_blank" rel="noreferrer">
              {t("github.openPage")}
            </a>
          </div>
          <p className="muted">{t("github.waiting")}</p>
        </div>
      )}

      {status.user && (
        <>
          <p className="muted">
            {t("github.signedIn", { user: status.user })}{" "}
            <button className="link" onClick={() => void disconnect()}>
              {t("github.disconnect")}
            </button>
          </p>

          {repo?.remote ? (
            <>
              <p>
                {t("github.remote")}{" "}
                {repo.url ? (
                  <a href={repo.url} target="_blank" rel="noreferrer">
                    {repo.url}
                  </a>
                ) : (
                  <span className="mono">{repo.remote}</span>
                )}
              </p>
              {done === "pushed" && <p className="is-ok">{t("github.pushed")}</p>}
              {errorText}
              {confirm ? (
                <div className="actions">
                  <span>{t("github.pushConfirm")}</span>
                  <button className="btn is-primary" disabled={busy} onClick={() => void run("push")}>
                    {busy ? t("github.working") : t("github.pushYes")}
                  </button>
                  <button className="btn" onClick={() => setConfirm(false)}>
                    {t("providers.cancel")}
                  </button>
                </div>
              ) : (
                <button
                  className="btn"
                  onClick={() => {
                    setDone(null);
                    setConfirm(true);
                  }}
                >
                  {t("github.push")}
                </button>
              )}
              <p className="muted">{t("github.onlyCommits")}</p>
            </>
          ) : (
            <>
              {done && done !== "pushed" && (
                <p className="is-ok">
                  {t("github.published")}{" "}
                  <a href={done} target="_blank" rel="noreferrer">
                    {done}
                  </a>
                </p>
              )}
              <div className="github-form">
                <label className="field">
                  <span>{t("github.name")}</span>
                  <input className="field-input mono" value={name} onChange={(e) => setName(e.target.value)} disabled={confirm} />
                </label>
                <Toggle checked={isPrivate} disabled={confirm} onChange={setPrivate}>
                  {t("github.private")}
                </Toggle>
              </div>
              {errorText}
              {confirm ? (
                <div className="actions">
                  <span>{t(isPrivate ? "github.confirmPrivate" : "github.confirmPublic", { repo: `${status.user}/${name}` })}</span>
                  <button className="btn is-primary" disabled={busy} onClick={() => void run("publish")}>
                    {busy ? t("github.working") : t("github.publishYes")}
                  </button>
                  <button className="btn" onClick={() => setConfirm(false)}>
                    {t("providers.cancel")}
                  </button>
                </div>
              ) : (
                <button className="btn is-primary" disabled={!/^[\w.-]{1,100}$/.test(name.trim())} onClick={() => setConfirm(true)}>
                  {t("github.publish")}
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
