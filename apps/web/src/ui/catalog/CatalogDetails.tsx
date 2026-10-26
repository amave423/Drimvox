import type { McpServerView, McpTrust } from "@drimvox/shared";
import { McpTrustChoice } from "../McpTrustChoice";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";
import { dimTitleBar } from "../../theme";
import type { MessageKey } from "../../i18n";
import type { CatalogEntry } from "../../lib/catalog";
import { CrossIcon } from "../SideChats";
import { CatalogLogo } from "./CatalogLogo";

/** A card's text by its part: catalog.e.<id>.<part>. */
export function useEntryText() {
  const { t } = useApp();
  return (entry: CatalogEntry, part: "name" | "about" | "details" | "can" | "example" | "steps" | "result") =>
    part === "name" && entry.name ? entry.name : t(`catalog.e.${entry.id}.${part}` as MessageKey);
}

/**
 * What using it looks like, drawn as a small Drimvox chat: the request, the actions it leads to, the answer (seen: the
 * details said little and showed nothing).
 */
function Example({ entry }: { entry: CatalogEntry }) {
  const { t } = useApp();
  const text = useEntryText();
  return (
    <figure className="catalog-example" aria-label={t("catalog.exampleTitle")}>
      <div className="catalog-example-bar" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="catalog-example-body">
        <p className="catalog-example-you">
          <span className="visually-hidden">{t("catalog.exampleYou")}: </span>
          {text(entry, "example")}
        </p>
        <ol className="catalog-example-steps">
          {text(entry, "steps")
            .split("|")
            .map((step, n) => (
              <li key={n}>
                <CatalogLogo logo={entry.logo} size={18} />
                {step}
              </li>
            ))}
        </ol>
        <p className="catalog-example-answer">{text(entry, "result")}</p>
      </div>
      <figcaption className="muted">{t("catalog.exampleTitle")}</figcaption>
    </figure>
  );
}

/** One card's details in a window: what it gives, an example, where it comes from, its key when it needs one. */
export function CatalogDetails(p: {
  entry: CatalogEntry;
  on: boolean;
  busy: boolean;
  needsSecret: boolean;
  /** A server switched on for the first time: how much it is trusted is chosen here. */
  setup: boolean;
  /** A server already added: how much it is trusted, changed here. */
  server?: McpServerView | null;
  onTrust?(trust: McpTrust): void;
  error: string | null;
  onTurn(on: boolean, secret?: string, trust?: McpTrust): void;
  onClose(): void;
}) {
  const { t } = useApp();
  const text = useEntryText();
  const ref = useRef<HTMLDialogElement>(null);
  const [secret, setSecret] = useState("");
  const [trust, setTrust] = useState<McpTrust>(p.entry.kind === "mcp" ? (p.entry.trust ?? "changes") : "changes");
  useEffect(() => {
    ref.current?.showModal();
    // The window's buttons dim with the page under the window.
    dimTitleBar(true, "--overlay-soft");
    return () => dimTitleBar(false, "--overlay-soft");
  }, []);
  const e = p.entry;
  const name = text(e, "name");
  return (
    <dialog ref={ref} className="catalog-dialog" aria-label={name} onClose={p.onClose} onClick={(ev) => ev.target === ref.current && ref.current?.close()}>
      <button type="button" className="catalog-close" aria-label={t("viewer.close")} onClick={() => ref.current?.close()}>
        <CrossIcon />
      </button>
      <header className="catalog-dialog-head">
        <CatalogLogo logo={e.logo} size={52} />
        <div>
          <h2>{name}</h2>
          <p className="muted">
            {t(e.kind === "mcp" ? "catalog.kind.mcp" : "catalog.kind.skill")} · {t("catalog.by", { vendor: e.vendor, license: e.license })}
          </p>
        </div>
      </header>
      <p>{text(e, "details")}</p>
      <Example entry={e} />
      <h3>{t("catalog.can")}</h3>
      <ul className="catalog-can">
        {text(e, "can")
          .split("|")
          .map((item, n) => (
            <li key={n}>{item}</li>
          ))}
      </ul>
      {e.kind === "mcp" ? (
        <>
          <p className="mono muted catalog-command">{e.server.command ? [e.server.command, ...(e.server.args ?? [])].join(" ") : e.server.url}</p>
          {e.server.command === "npx" && <p className="muted">{t("catalog.needsNode")}</p>}
        </>
      ) : (
        <p className="muted">
          {t("catalog.skillNote")} {e.source.kind === "github" ? t("catalog.skillFrom", { repo: e.source.repo }) : t("catalog.skillBuiltin")}
        </p>
      )}
      <p>
        <a href={e.link} target="_blank" rel="noreferrer">
          {t("catalog.source")}
        </a>
      </p>
      {/* Asked for: a server one switches on works without questions — once it is said what it may do. */}
      {p.setup && e.kind === "mcp" && <McpTrustChoice value={trust} onChange={setTrust} name={name} />}
      {!p.setup && p.server && p.onTrust && <McpTrustChoice value={p.server.trust} onChange={p.onTrust} name={name} />}
      {p.needsSecret && e.kind === "mcp" && e.secret ? (
        <form
          className="catalog-secret"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (secret.trim()) p.onTurn(true, secret.trim(), trust);
          }}
        >
          <label className="field">
            <span className="field-label">{t("catalog.secretLabel", { name })}</span>
            <input className="field-input mono" type="password" autoComplete="off" value={secret} onChange={(ev) => setSecret(ev.target.value)} />
          </label>
          <p className="muted">
            {t("catalog.secretHelp")}{" "}
            <a href={e.secret.helpUrl} target="_blank" rel="noreferrer">
              {t("catalog.getToken")}
            </a>
          </p>
          <div className="actions">
            <button className="btn is-primary" disabled={!secret.trim() || p.busy}>
              {t("catalog.turnOn")}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className={p.on ? "btn" : "btn is-primary"} disabled={p.busy} onClick={() => p.onTurn(!p.on, undefined, p.setup ? trust : undefined)}>
            {p.busy ? t("catalog.installing") : t(p.on ? "catalog.turnOff" : "catalog.turnOn")}
          </button>
        </div>
      )}
      {p.error && <p className="is-pencil-text">{t(p.error === "download" ? "catalog.failedDownload" : "catalog.failed")}</p>}
    </dialog>
  );
}
