import { useState } from "react";
import { useApp } from "../context";

type Status = "idle" | "changed" | "wrong" | "short" | "failed";

/** The server in a browser: change the password (other devices sign out) and sign out here. */
export function AccountSection() {
  const { api, t } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function change() {
    if (next.length < 8) return setStatus("short");
    const res = await api.auth.password.$post({ json: { current, next } }).catch(() => null);
    if (res?.ok) {
      setCurrent("");
      setNext("");
      return setStatus("changed");
    }
    setStatus(res?.status === 403 ? "wrong" : "failed");
  }

  async function signOut() {
    await api.auth.logout.$post().catch(() => null);
    location.reload();
  }

  return (
    <>
      <h2 className="sheet-h">{t("account.title")}</h2>
      <form
        className="account-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (current && next) void change();
        }}
      >
        <input
          className="field-input"
          type="password"
          autoComplete="current-password"
          placeholder={t("account.current")}
          aria-label={t("account.current")}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className="field-input"
          type="password"
          autoComplete="new-password"
          placeholder={t("account.next")}
          aria-label={t("account.next")}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <button className="btn" disabled={!current || !next}>
          {t("account.change")}
        </button>
      </form>
      <div aria-live="polite">
        {status === "changed" && <p className="is-ok">{t("account.changed")}</p>}
        {status === "wrong" && <p className="is-pencil-text">{t("account.wrong")}</p>}
        {status === "short" && <p className="is-pencil-text">{t("signin.short")}</p>}
        {status === "failed" && <p className="is-pencil-text">{t("signin.failed")}</p>}
      </div>
      <div className="actions">
        <button className="link is-pencil" onClick={() => void signOut()}>
          {t("account.signOut")}
        </button>
      </div>
    </>
  );
}
