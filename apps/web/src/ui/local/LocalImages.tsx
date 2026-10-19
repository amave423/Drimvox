import type { LocalImageModelId, LocalImagesStatus } from "@artel/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { PullControl, type PullActions } from "./PullControl";

/**
 * Pictures on this computer (docs/specs/local-images.md): the short list sized for it, downloads with the engine,
 * and a word on where the models show up once downloaded.
 */
export function LocalImagesSection() {
  const { api, t, reloadProviders } = useApp();
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
  const downloading = !!status?.models.some((m) => m.pull && !m.pull.done && !m.pull.paused);
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

  if (!status) return null;
  return (
    <>
      <h2 className="sheet-h">{t("localImages.title")}</h2>
      <p className="muted">{t("localImages.hint")}</p>
      {!status.supported && <p className="note">{t("localImages.unsupported")}</p>}
      {status.supported && status.models.length === 0 && <p className="muted">{t("localImages.none")}</p>}
      {status.supported && status.models.length > 0 && (
        <>
          {!status.engine && <p className="muted">{t("localImages.engineFirst")}</p>}
          <ul className="local-cards local-image-cards">
            {status.models.map((m) => (
              <li key={m.id} className="local-card">
                <div className="local-card-head">
                  <span className="local-card-name">{m.name}</span>
                  <span className={`local-fit is-${m.fit}`} title={t(m.fit === "fast" ? "localImages.fastHint" : "localImages.slowHint")}>
                    {t(m.fit === "fast" ? "local.fast" : "local.slow")}
                  </span>
                </div>
                <p>{t(`localImages.model.${m.id}` as MessageKey)}</p>
                <PullControl model={m.id} sizeBytes={m.sizeBytes} installed={m.installed} pull={m.pull ?? undefined} actions={actions} />
              </li>
            ))}
          </ul>
          {status.models.some((m) => m.installed) && <p className="note">{t("localImages.where")}</p>}
        </>
      )}
    </>
  );
}
