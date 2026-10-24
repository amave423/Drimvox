import type { LocalImageModelId, LocalImagesStatus } from "@drimvox/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { LocalMediaSearch } from "./LocalMediaSearch";
import { PullControl, type PullActions } from "./PullControl";
import { useSize } from "./size";

/**
 * Pictures on this computer (docs/specs/local-images.md): the short list sized for it, downloads with the engine,
 * and a word on where the models show up once downloaded.
 */
export function LocalImagesSection({ kind }: { kind: "image" | "video" }) {
  const { api, t, reloadProviders } = useApp();
  const size = useSize();
  const [status, setStatus] = useState<LocalImagesStatus | null>(null);
  const known = useRef<string | null>(null);

  const load = useCallback(async () => {
    const next = await api.local.images
      .$get()
      .then((r) => ok<LocalImagesStatus>(r))
      .catch(() => null);
    if (!next) return;
    setStatus(next);
    // A finished download makes the provider and its model: the picture chats should see it at once.
    const key = `${next.providerId}:${next.models.filter((m) => m.installed).map((m) => m.id).join()}`;
    if (known.current !== null && known.current !== key) void reloadProviders();
    known.current = key;
  }, [api, reloadProviders]);

  useEffect(() => {
    void load();
  }, [load]);
  const downloading = !!status?.models.some((m) => m.pull && !m.pull.done && !m.pull.paused) || !!(status?.enginePull && !status.enginePull.done);
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [downloading, load]);

  const id = (model: string) => model as LocalImageModelId;
  const act = (run: (model: LocalImageModelId) => Promise<unknown>) => (model: string) =>
    void run(id(model))
      .catch(() => null)
      .then(() => load());
  const actions: PullActions = {
    pull: act((model) => api.local.images.pulls.$post({ json: { model } })),
    pause: act((model) => api.local.images.pulls.pause.$post({ json: { model } })),
    cancel: act((model) => api.local.images.pulls.$delete({ query: { model } })),
    remove: act((model) => api.local.images.models[":id"].$delete({ param: { id: model } })),
  };

  const getEngine = () =>
    void api.local.images.engine
      .$post()
      .catch(() => null)
      .then(() => load());

  if (!status) return null;
  const ep = status.enginePull;
  const models = status.models.filter((m) => m.kind === kind);
  const k = kind === "image" ? "localImages" : "localVideo";
  return (
    <>
      <h2 className="sheet-h">{t(`${k}.title`)}</h2>
      <p className="muted">{t(`${k}.hint`)}</p>
      {!status.supported && <p className="note">{t("localImages.unsupported")}</p>}
      {status.supported && models.length === 0 && <p className="muted">{t(`${k}.none`)}</p>}
      {status.supported && models.length > 0 && (
        <>
          {!status.engine && (
            <div className="local-row local-engine">
              <span>{t("localImages.engine")}</span>
              {ep && !ep.done ? (
                <span className="muted">{ep.total > 0 ? t("localImages.engineLoading", { done: size(ep.completed), total: size(ep.total) }) : t("localImages.engineStarting")}</span>
              ) : (
                <button type="button" className="btn" onClick={getEngine}>
                  {t("localImages.engineGet")}
                </button>
              )}
              {ep?.error && <span className="is-pencil-text local-why">{t("localImages.engineFailed")}</span>}
            </div>
          )}
          <ul className="local-cards local-image-cards">
            {models.map((m) => (
              <li key={m.id} className="local-card">
                <div className="local-card-head">
                  <span className="local-card-name">{m.name}</span>
                  <span className={`local-fit is-${m.fit}`} title={t(m.fit === "fast" ? `${k}.fastHint` : `${k}.slowHint`)}>
                    {t(m.fit === "fast" ? "local.fast" : "local.slow")}
                  </span>
                </div>
                <p>{m.source === "hf" ? t("localImages.found") : t(`localImages.model.${m.id}` as MessageKey)}</p>
                <PullControl model={m.id} sizeBytes={m.sizeBytes} installed={m.installed} pull={m.pull ?? undefined} actions={actions} />
              </li>
            ))}
          </ul>
          {models.some((m) => m.installed) && <p className="note">{t(`${k}.where`)}</p>}
        </>
      )}
      {status.supported && <LocalMediaSearch kind={kind} status={status} actions={actions} />}
    </>
  );
}
