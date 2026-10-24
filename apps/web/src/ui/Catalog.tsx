import type { McpServerView, SkillView } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { ok } from "../api";
import { useApp } from "../context";
import { CATALOG, installed, type CatalogEntry } from "../lib/catalog";
import { Hint } from "./Hint";
import { CrossIcon } from "./SideChats";
import { Toggle } from "./Toggle";

/**
 * Ready MCP servers and skills as cards (docs/specs/catalog.md): switched on in one click, a secret asked only where one
 * is needed, the details in a window (seen: adding a server by its command was for those who already knew it).
 */
export function Catalog({ onChanged }: { onChanged(): void }) {
  const { api, t } = useApp();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [open, setOpen] = useState<CatalogEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function load() {
    const [s, k] = await Promise.all([
      api.mcp.$get().then((r) => ok<McpServerView[]>(r)).catch(() => []),
      api.skills.$get().then((r) => ok<SkillView[]>(r)).catch(() => []),
    ]);
    setServers(s);
    setSkills(k);
  }
  useEffect(() => void load(), []);

  /** On: creates the server or the skill (or switches the server back on); off: switches the server off, removes the skill. */
  async function turn(entry: CatalogEntry, on: boolean, secret?: string) {
    setBusy(entry.id);
    setFailed(null);
    const have = installed(entry, servers, skills);
    let res: Response | null = null;
    if (entry.kind === "skill") {
      res = on
        ? ((await api.skills.$post({ json: { name: entry.slug, description: entry.description, instructions: entry.instructions } }).catch(() => null)) as Response | null)
        : ((await api.skills[":name"].$delete({ param: { name: entry.slug } }).catch(() => null)) as Response | null);
    } else if (have) {
      res = (await api.mcp[":id"].$patch({ param: { id: (have as McpServerView).id }, json: { enabled: on } }).catch(() => null)) as Response | null;
    } else if (on) {
      const headers = entry.secret && secret ? { [entry.secret.header]: `${entry.secret.prefix}${secret}` } : {};
      res = (await api.mcp
        .$post({ json: { name: entry.name, ...(entry.server.command ? { command: entry.server.command, args: entry.server.args ?? [] } : { url: entry.server.url! }), env: {}, headers } })
        .catch(() => null)) as Response | null;
    }
    setBusy(null);
    if (res && !res.ok) setFailed(entry.id);
    await load();
    onChanged();
  }

  const isOn = (entry: CatalogEntry) => {
    const have = installed(entry, servers, skills);
    return !!have && (entry.kind === "skill" || (have as McpServerView).enabled);
  };
  const name = (entry: CatalogEntry) => (entry.kind === "skill" ? t(entry.name) : entry.name);

  return (
    <section className="catalog" aria-labelledby="catalog-h">
      <h2 className="sheet-h" id="catalog-h">
        {t("catalog.title")}
        <Hint text={t("catalog.hint")} />
      </h2>
      <ul className="catalog-grid">
        {CATALOG.map((entry) => (
          <li key={entry.id} className="catalog-card">
            <div className="catalog-card-head">
              <strong>{name(entry)}</strong>
              <span className="catalog-kind muted">{t(entry.kind === "mcp" ? "catalog.kind.mcp" : "catalog.kind.skill")}</span>
            </div>
            <p className="muted">{t(entry.about)}</p>
            <div className="catalog-card-foot">
              <Toggle
                checked={isOn(entry)}
                disabled={busy === entry.id}
                onChange={(on) => {
                  // A server that needs a secret asks for it in its window first.
                  if (on && entry.kind === "mcp" && entry.secret && !installed(entry, servers, skills)) return setOpen(entry);
                  void turn(entry, on);
                }}
              >
                <span className="visually-hidden">{name(entry)}</span>
              </Toggle>
              <button type="button" className="link" onClick={() => setOpen(entry)}>
                {t("catalog.more")}
              </button>
            </div>
            {failed === entry.id && <p className="is-pencil-text">{t("catalog.failed")}</p>}
          </li>
        ))}
      </ul>
      {open && (
        <CatalogDetails
          entry={open}
          name={name(open)}
          on={isOn(open)}
          needsSecret={open.kind === "mcp" && !!open.secret && !installed(open, servers, skills)}
          onTurn={(on, secret) => void turn(open, on, secret).then(() => setOpen(null))}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

/** One card's details in a window: what it gives, what it runs, and its secret when it needs one. Escape closes it. */
function CatalogDetails(p: { entry: CatalogEntry; name: string; on: boolean; needsSecret: boolean; onTurn(on: boolean, secret?: string): void; onClose(): void }) {
  const { t } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const [secret, setSecret] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const e = p.entry;
  return (
    <dialog ref={ref} className="catalog-dialog" aria-label={p.name} onClose={p.onClose} onClick={(ev) => ev.target === ref.current && ref.current?.close()}>
      <button type="button" className="catalog-close" aria-label={t("viewer.close")} onClick={() => ref.current?.close()}>
        <CrossIcon />
      </button>
      <h2>{p.name}</h2>
      <p>{t(e.details)}</p>
      {e.kind === "mcp" ? (
        <>
          <p className="mono muted catalog-command">{e.server.command ? [e.server.command, ...(e.server.args ?? [])].join(" ") : e.server.url}</p>
          <p>
            <a href={e.link} target="_blank" rel="noreferrer">
              {t("catalog.source")}
            </a>
          </p>
        </>
      ) : (
        <p className="muted">{t("catalog.skillNote")}</p>
      )}
      {p.needsSecret && e.kind === "mcp" && e.secret ? (
        <form
          className="catalog-secret"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (secret.trim()) p.onTurn(true, secret.trim());
          }}
        >
          <label className="field">
            <span className="field-label">{t(e.secret.label)}</span>
            <input className="field-input mono" type="password" autoComplete="off" value={secret} onChange={(ev) => setSecret(ev.target.value)} />
          </label>
          <p className="muted">
            {t(e.secret.help)}{" "}
            <a href={e.secret.helpUrl} target="_blank" rel="noreferrer">
              {t("catalog.getToken")}
            </a>
          </p>
          <div className="actions">
            <button className="btn is-primary" disabled={!secret.trim()}>
              {t("catalog.turnOn")}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className={p.on ? "btn" : "btn is-primary"} onClick={() => p.onTurn(!p.on)}>
            {t(p.on ? "catalog.turnOff" : "catalog.turnOn")}
          </button>
        </div>
      )}
    </dialog>
  );
}
