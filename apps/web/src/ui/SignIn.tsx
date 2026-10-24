import type { Locale } from "@drimvox/shared";
import { useState } from "react";
import type { Api } from "../api";
import { translate, type MessageKey } from "../i18n";

interface Props {
  api: Api;
  locale: Locale;
  /** False on the very first visit: the password is set here, with the code from the server's log. */
  passwordSet: boolean;
}

const problems: Record<number, MessageKey> = {
  400: "signin.short",
  401: "signin.wrong",
  403: "signin.badCode",
  409: "signin.alreadySet",
  429: "signin.wait",
};

/** The server in a browser: set the first password, or sign in. Shown before the app context exists. */
export function SignIn({ api, locale, passwordSet }: Props) {
  const t = (key: MessageKey) => translate(locale, key);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  async function submit() {
    if (!passwordSet && password !== repeat) return setProblem("signin.mismatch");
    if (!passwordSet && password.length < 8) return setProblem("signin.short");
    setBusy(true);
    setProblem(null);
    const res = await (passwordSet
      ? api.auth.login.$post({ json: { password } })
      : api.auth.setup.$post({ json: { password, code: code.trim() } })
    ).catch(() => null);
    setBusy(false);
    // The session cookie is set; the app starts over signed in.
    if (res?.ok) return location.reload();
    setProblem(res ? (problems[res.status] ?? "signin.failed") : "signin.failed");
  }

  return (
    <main className="desk is-alone">
      <article className="sheet">
        <form
          className="sheet-body signin"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && password) void submit();
          }}
        >
          <h1>{passwordSet ? t("signin.title") : t("signin.setupTitle")}</h1>
          <p className="lede">{passwordSet ? t("signin.lede") : t("signin.setupLede")}</p>
          {!passwordSet && (
            <>
              <code className="mono cli-install">sudo journalctl -u drimvox | grep -i code</code>
              <label className="field">
                <span>{t("signin.code")}</span>
                <input className="field-input mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
              </label>
            </>
          )}
          <label className="field">
            <span>{passwordSet ? t("signin.password") : t("signin.newPassword")}</span>
            <input
              className="field-input"
              type="password"
              autoComplete={passwordSet ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={passwordSet}
            />
          </label>
          {!passwordSet && (
            <label className="field">
              <span>{t("signin.repeat")}</span>
              <input className="field-input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </label>
          )}
          {problem && (
            <p className="error-note" role="alert">
              {t(problem)}
            </p>
          )}
          <div className="actions">
            <button className="btn is-primary" disabled={busy || !password || (!passwordSet && !code.trim())}>
              {passwordSet ? t("signin.submit") : t("signin.setupSubmit")}
            </button>
          </div>
        </form>
      </article>
    </main>
  );
}
