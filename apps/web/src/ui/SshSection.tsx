import type { SshServerInput, SshServerView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { Segmented } from "./Segmented";

const empty: SshServerInput = { name: "", host: "", port: 22, user: "", auth: "key", password: "", keyPath: "", trust: "ask" };

/**
 * Other computers the agent works on over SSH (docs/specs/ssh.md; seen: a password written into a plink command and kept in
 * the chat). Saved once here, the password encrypted; the agent names the server, never sees the sign-in.
 */
export function SshSection() {
  const { api, t } = useApp();
  const [servers, setServers] = useState<SshServerView[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: SshServerInput } | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; text: string } | "checking">>({});
  const [failed, setFailed] = useState<string | null>(null);

  const load = () =>
    void api.ssh
      .$get()
      .then((r) => r.json())
      .then((list) => setServers(list as SshServerView[]))
      .catch(() => setServers([]));
  useEffect(load, [api]);

  async function save() {
    if (!editing) return;
    setFailed(null);
    const json = { ...editing.input, password: editing.input.auth === "password" && editing.input.password ? editing.input.password : undefined, keyPath: editing.input.keyPath || undefined };
    const res = await (editing.id ? api.ssh[":id"].$put({ param: { id: editing.id }, json }) : api.ssh.$post({ json })).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
      return setFailed(body?.error?.code ?? "unknown");
    }
    setEditing(null);
    load();
  }
  async function check(id: string) {
    setChecks((c) => ({ ...c, [id]: "checking" }));
    const res = await api.ssh[":id"].check.$post({ param: { id } }).catch(() => null);
    const body = res?.ok ? ((await res.json()) as { ok: boolean; output?: string; error?: string }) : { ok: false, error: t("ssh.checkFailed") };
    setChecks((c) => ({ ...c, [id]: { ok: body.ok, text: body.ok ? (body.output ?? "") : (body.error ?? "") } }));
    load();
  }
  async function remove(id: string) {
    await api.ssh[":id"].$delete({ param: { id } }).catch(() => null);
    load();
  }

  const set = (patch: Partial<SshServerInput>) => setEditing((e) => (e ? { ...e, input: { ...e.input, ...patch } } : e));
  const ready = editing && editing.input.name.trim() && editing.input.host.trim() && editing.input.user.trim();

  return (
    <>
      <h2 className="sheet-h">{t("ssh.title")}</h2>
      <p className="setting-about">{t("ssh.lede")}</p>
      {servers === null ? (
        <p className="muted">{t("model.loading")}</p>
      ) : (
        <ul className="ssh-list">
          {servers.map((s) => {
            const c = checks[s.id];
            return (
              <li key={s.id} className="ssh-item">
                <div className="ssh-head">
                  <strong>{s.name}</strong>
                  <span className="mono muted">
                    {s.user}@{s.host}
                    {s.port !== 22 ? `:${s.port}` : ""}
                  </span>
                  <span className={`ssh-badge${s.trust === "trusted" ? " is-trusted" : ""}`}>{t(s.trust === "trusted" ? "ssh.trusted" : "ssh.asks")}</span>
                </div>
                <small className="muted">
                  {t(s.auth === "password" ? "ssh.byPassword" : "ssh.byKey")}
                  {s.fingerprint ? ` · ${t("ssh.fingerprint", { key: s.fingerprint.slice(0, 20) })}…` : ""}
                </small>
                {c && <p className={c === "checking" ? "muted" : c.ok ? "ssh-ok" : "error-note"}>{c === "checking" ? t("ssh.checking") : c.ok ? t("ssh.ok", { host: c.text }) : c.text}</p>}
                <div className="actions">
                  <button className="btn" disabled={c === "checking"} onClick={() => void check(s.id)}>
                    {t("ssh.check")}
                  </button>
                  <button className="btn" onClick={() => setEditing({ id: s.id, input: { name: s.name, host: s.host, port: s.port, user: s.user, auth: s.auth, password: "", keyPath: s.keyPath ?? "", trust: s.trust } })}>
                    {t("ssh.edit")}
                  </button>
                  <button className="btn is-pencil" onClick={() => void remove(s.id)}>
                    {t("ssh.remove")}
                  </button>
                </div>
              </li>
            );
          })}
          {servers.length === 0 && !editing && <p className="muted">{t("ssh.empty")}</p>}
        </ul>
      )}
      {editing ? (
        <form
          className="ssh-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void save();
          }}
        >
          <label className="field">
            <span>{t("ssh.name")}</span>
            <input className="field-input" value={editing.input.name} placeholder={t("ssh.namePlaceholder")} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <div className="ssh-row">
            <label className="field">
              <span>{t("ssh.host")}</span>
              <input className="field-input mono" value={editing.input.host} placeholder="192.168.1.10" onChange={(e) => set({ host: e.target.value })} />
            </label>
            <label className="field ssh-port">
              <span>{t("ssh.port")}</span>
              <input className="field-input mono" inputMode="numeric" value={String(editing.input.port)} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 22 })} />
            </label>
          </div>
          <label className="field">
            <span>{t("ssh.user")}</span>
            <input className="field-input mono" value={editing.input.user} placeholder="root" onChange={(e) => set({ user: e.target.value })} />
          </label>
          <div className="field">
            <span id="ssh-auth">{t("ssh.auth")}</span>
            <Segmented labelledBy="ssh-auth" value={editing.input.auth} options={[{ value: "key", label: t("ssh.byKey") }, { value: "password", label: t("ssh.byPassword") }]} onChange={(auth) => set({ auth })} />
          </div>
          {editing.input.auth === "password" ? (
            <label className="field">
              <span>{t("ssh.password")}</span>
              <input className="field-input" type="password" autoComplete="new-password" value={editing.input.password ?? ""} placeholder={editing.id ? t("ssh.passwordKeep") : ""} onChange={(e) => set({ password: e.target.value })} />
            </label>
          ) : (
            <div className="field">
              <span>{t("ssh.keyPath")}</span>
              <div className="ssh-key">
                <input className="field-input mono" aria-label={t("ssh.keyPath")} value={editing.input.keyPath ?? ""} placeholder={t("ssh.keyDefault")} onChange={(e) => set({ keyPath: e.target.value })} />
                {window.drimvox?.pickKey && (
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const path = await window.drimvox!.pickKey!();
                      if (path) set({ keyPath: path });
                    }}
                  >
                    {t("ssh.pickKey")}
                  </button>
                )}
              </div>
              <small className="muted">{t("ssh.keyHint")}</small>
            </div>
          )}
          <div className="field">
            <span id="ssh-trust">{t("ssh.trust")}</span>
            <Segmented labelledBy="ssh-trust" value={editing.input.trust} options={[{ value: "ask", label: t("ssh.asks") }, { value: "trusted", label: t("ssh.trusted") }]} onChange={(trust) => set({ trust })} />
          </div>
          {failed && <p className="error-note">{t(failed.startsWith("key_") ? (`ssh.error.${failed}` as MessageKey) : "ssh.saveFailed")}</p>}
          <div className="actions">
            <button className="btn is-primary" disabled={!ready}>
              {t("ssh.save")}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("providers.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" onClick={() => setEditing({ id: null, input: empty })}>
          {t("ssh.add")}
        </button>
      )}
    </>
  );
}
