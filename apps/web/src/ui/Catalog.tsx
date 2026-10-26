import type { McpServerView, SkillView, McpTrust } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../api";
import { useApp } from "../context";
import { CATALOG, installed, type CatalogCategory, type CatalogEntry } from "../lib/catalog";
import { TrashIcon } from "./SideChats";
import { CatalogDetails, useEntryText } from "./catalog/CatalogDetails";
import { CatalogLogo } from "./catalog/CatalogLogo";
import { Hint } from "./Hint";
import { Toggle } from "./Toggle";

const CATEGORIES: ("all" | CatalogCategory)[] = ["all", "web", "code", "design", "docs"];

/**
 * Ready MCP servers and skills as cards (docs/specs/catalog.md): switched on in one click, a key asked only where one is
 * needed, the details with an example in a window. Skills come from their authors' repositories.
 */
export function Catalog({ kind, onChanged }: { kind: "mcp" | "skill"; onChanged(): void }) {
  const { api, t } = useApp();
  const text = useEntryText();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [category, setCategory] = useState<"all" | CatalogCategory>("all");
  const [open, setOpen] = useState<CatalogEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; code: string } | null>(null);

  async function load() {
    const [s, k] = await Promise.all([
      api.mcp.$get().then((r) => ok<McpServerView[]>(r)).catch(() => []),
      api.skills.$get().then((r) => ok<SkillView[]>(r)).catch(() => []),
    ]);
    setServers(s);
    setSkills(k);
  }
  useEffect(() => void load(), []);

  /** On: installs the skill or creates the server (or switches it back on); off: removes the skill, switches the server off. */
  async function turn(entry: CatalogEntry, on: boolean, secret?: string, trust?: McpTrust): Promise<boolean> {
    setBusy(entry.id);
    setFailed(null);
    const have = installed(entry, servers, skills);
    let res: Response | null = null;
    if (entry.kind === "skill") {
      res = on
        ? ((await api.skills.install.$post({ json: { source: entry.source } }).catch(() => null)) as Response | null)
        : ((await api.skills[":name"].$delete({ param: { name: entry.skill } }).catch(() => null)) as Response | null);
    } else if (have) {
      res = (await api.mcp[":id"].$patch({ param: { id: (have as McpServerView).id }, json: { enabled: on } }).catch(() => null)) as Response | null;
    } else if (on) {
      const s = entry.secret;
      const env = s?.env && secret ? { [s.env]: secret } : {};
      const headers = s?.header && secret ? { [s.header.name]: `${s.header.prefix}${secret}` } : {};
      const how = entry.server.command ? { command: entry.server.command, args: entry.server.args ?? [] } : { url: entry.server.url! };
      res = (await api.mcp.$post({ json: { name: text(entry, "name"), ...how, env, headers, trust: trust ?? entry.trust ?? "changes" } }).catch(() => null)) as Response | null;
    }
    setBusy(null);
    const done = !!res?.ok;
    if (!done) {
      const code = ((await res?.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? "failed";
      setFailed({ id: entry.id, code });
    }
    await load();
    onChanged();
    return done;
  }

  /** Deletes what a card switched on, at once: the server with its settings, or the skill's folder (asked for). */
  async function remove(entry: CatalogEntry) {
    const have = installed(entry, servers, skills);
    if (!have) return;
    setBusy(entry.id);
    if (entry.kind === "skill") await api.skills[":name"].$delete({ param: { name: entry.skill } }).catch(() => null);
    else await api.mcp[":id"].$delete({ param: { id: (have as McpServerView).id } }).catch(() => null);
    setBusy(null);
    await load();
    onChanged();
  }

  const isOn = (entry: CatalogEntry) => {
    const have = installed(entry, servers, skills);
    return !!have && (entry.kind === "skill" || (have as McpServerView).enabled);
  };
  const needsSecret = (entry: CatalogEntry) => entry.kind === "mcp" && !!entry.secret && !installed(entry, servers, skills);
  // A server switched on for the first time opens its window: what it may do without asking is said and chosen there.
  const needsSetup = (entry: CatalogEntry) => entry.kind === "mcp" && !installed(entry, servers, skills);
  const own = CATALOG.filter((e) => e.kind === kind);
  // Only the categories that have cards of this kind.
  const categories = CATEGORIES.filter((c) => c === "all" || own.some((e) => e.category === c));
  const shown = own.filter((e) => category === "all" || e.category === category);

  return (
    <section className="catalog" aria-labelledby="catalog-h">
      <h2 className="sheet-h" id="catalog-h">
        {t(kind === "mcp" ? "catalog.titleMcp" : "catalog.titleSkills")}
        <Hint text={t(kind === "mcp" ? "catalog.hintMcp" : "catalog.hintSkills")} />
      </h2>
      <div className="catalog-filter" role="group" aria-label={t("catalog.title")}>
        {categories.map((c) => (
          <button key={c} type="button" className={c === category ? "chip is-on" : "chip"} aria-pressed={c === category} onClick={() => setCategory(c)}>
            {t(`catalog.cat.${c}`)}
          </button>
        ))}
      </div>
      <ul className="catalog-grid">
        {shown.map((entry) => (
          <li key={entry.id} className="catalog-card">
            <div className="catalog-card-head">
              <CatalogLogo logo={entry.logo} />
              <div className="catalog-card-title">
                <strong>{text(entry, "name")}</strong>
                <span className="muted">{entry.vendor}</span>
              </div>
            </div>
            <p className="muted">{text(entry, "about")}</p>
            <div className="catalog-card-foot">
              <Toggle
                checked={isOn(entry)}
                disabled={busy === entry.id}
                onChange={(on) => {
                  // A server that needs a key asks for it in its window first.
                  if (on && needsSetup(entry)) return setOpen(entry);
                  void turn(entry, on);
                }}
              >
                <span className="visually-hidden">{text(entry, "name")}</span>
                {busy === entry.id && <span className="muted">{t("catalog.installing")}</span>}
              </Toggle>
              <span className="catalog-card-actions">
                {installed(entry, servers, skills) && (
                  <button
                    type="button"
                    className="icon-button is-pencil"
                    aria-label={t("catalog.remove", { name: text(entry, "name") })}
                    title={t("catalog.remove", { name: text(entry, "name") })}
                    disabled={busy === entry.id}
                    onClick={() => void remove(entry)}
                  >
                    <TrashIcon />
                  </button>
                )}
                <button type="button" className="link" onClick={() => setOpen(entry)}>
                  {t("catalog.more")}
                </button>
              </span>
            </div>
            {failed?.id === entry.id && !open && <p className="is-pencil-text">{t(failed.code === "download" ? "catalog.failedDownload" : "catalog.failed")}</p>}
          </li>
        ))}
      </ul>
      {open && (
        <CatalogDetails
          entry={open}
          on={isOn(open)}
          busy={busy === open.id}
          needsSecret={needsSecret(open)}
          setup={needsSetup(open)}
          server={open.kind === "mcp" ? (installed(open, servers, skills) as McpServerView | null) : null}
          onTrust={async (trust) => {
            const have = installed(open, servers, skills) as McpServerView | null;
            if (have) await api.mcp[":id"].$patch({ param: { id: have.id }, json: { trust } }).catch(() => null);
            await load();
          }}
          error={failed?.id === open.id ? failed.code : null}
          onTurn={(on, secret, trust) => void turn(open, on, secret, trust).then((done) => done && setOpen(null))}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
