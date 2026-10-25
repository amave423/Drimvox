import type { ListedModel, ProviderView } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { ProviderLogo } from "./ProviderLogo";

type Filter = "all" | "offered" | "other";

/**
 * Every model a provider lists, the ones Drimvox does not offer too, each with where it is offered (asked for: to see
 * even the models the app does not support).
 */
export function AllModels({ provider, onClose }: { provider: ProviderView; onClose(): void }) {
  const { api, t } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const [models, setModels] = useState<ListedModel[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    ref.current?.showModal();
    void api.providers[":id"].models.all
      .$get({ param: { id: provider.id } })
      .then((r) => ok<ListedModel[]>(r))
      .then(setModels)
      .catch(() => setFailed(true));
  }, [api, provider.id]);

  const q = query.trim().toLowerCase();
  const shown = (models ?? []).filter(
    (m) => (filter === "all" || (filter === "offered") === (m.offered !== null)) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
  );
  const offered = models?.filter((m) => m.offered).length ?? 0;
  return (
    <dialog ref={ref} className="catalog-dialog all-models" aria-label={t("allModels.title", { name: provider.name })} onClose={onClose} onClick={(ev) => ev.target === ref.current && ref.current?.close()}>
      <button type="button" className="catalog-close" aria-label={t("viewer.close")} onClick={() => ref.current?.close()}>
        ✕
      </button>
      <header className="catalog-dialog-head">
        <ProviderLogo preset={provider.preset} name={provider.name} size={44} />
        <div>
          <h2>{t("allModels.title", { name: provider.name })}</h2>
          {models && <p className="muted">{t("allModels.counts", { all: models.length, offered })}</p>}
        </div>
      </header>
      <div className="all-models-tools">
        <input className="field-input" placeholder={t("model.search")} aria-label={t("model.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="catalog-filter">
          {(["all", "offered", "other"] as const).map((f) => (
            <button key={f} type="button" className={`chip${filter === f ? " is-on" : ""}`} onClick={() => setFilter(f)}>
              {t(`allModels.filter.${f}`)}
            </button>
          ))}
        </div>
      </div>
      {failed && <p className="error-note">{t("allModels.failed")}</p>}
      {!models && !failed && <p className="muted">{t("model.loading")}</p>}
      <ul className="all-models-list">
        {shown.map((m) => (
          <li key={m.id}>
            <span className="all-models-name">
              <span className="mono">{m.id}</span>
              {m.name !== m.id && <small className="muted">{m.name}</small>}
            </span>
            <span className={`local-fit ${m.offered ? "is-fast" : "is-quiet"}`}>{t(`allModels.offered.${m.offered ?? "none"}`)}</span>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
