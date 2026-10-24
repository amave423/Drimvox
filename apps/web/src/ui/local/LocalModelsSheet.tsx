import type { LocalPull, LocalStatus } from "@drimvox/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { InstallOllama } from "./InstallOllama";
import { forgetModels } from "../../lib/models";
import { LocalCatalogView } from "./LocalCatalog";
import { LocalImagesSection } from "./LocalImages";
import { Segmented } from "../Segmented";
import type { LocalPart } from "../../context";
import { PullControl, type PullActions } from "./PullControl";
import { useSize } from "./size";


/** Models on this computer through Ollama: its state, what is downloaded and downloading, the catalog. */
export function LocalModelsSheet({ part: first }: { part?: LocalPart }) {
  const { api, t, reloadProviders } = useApp();
  const size = useSize();
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const known = useRef<string | null>(null);
  // Three parts on one sheet (seen: everything one under another was a long page): text through Ollama, pictures, video.
  const [part, setPart] = useState<LocalPart>(first ?? "text");

  const load = useCallback(async () => {
    try {
      const next = await api.local.$get().then((r) => ok<LocalStatus>(r));
      setStatus(next);
      setFailed(false);
      // A finished download may have added the Ollama provider: the chat's model list should know.
      const key = `${next.providerId}:${next.models.map((m) => m.name).join()}`;
      if (known.current !== null && known.current !== key) {
        // The chat's model list was read before the download: read it again (seen: the new model showed only after a restart).
        if (next.providerId) forgetModels(next.providerId);
        void reloadProviders();
      }
      known.current = key;
    } catch {
      setFailed(true);
    }
  }, [api, reloadProviders]);

  useEffect(() => {
    void load();
  }, [load]);
  // While something downloads (a model, or Ollama itself), progress is read every second.
  const downloading = !!status?.pulls.some((p) => !p.done && !p.paused) || status?.install.state === "downloading" || status?.install.state === "installing";
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [downloading, load]);

  const pause = async (model: string) => {
    await api.local.pulls.pause.$post({ json: { model } }).catch(() => null);
    await load();
  };
  const pull = async (model: string) => {
    await api.local.pulls.$post({ json: { model } }).catch(() => null);
    await load();
  };
  const cancel = async (model: string) => {
    await api.local.pulls.$delete({ query: { model } }).catch(() => null);
    await load();
  };
  const remove = async (name: string) => {
    setConfirm(null);
    await api.local.models.$delete({ query: { name } }).catch(() => null);
    await load();
  };
  const connect = async () => {
    await api.local.connect.$post().catch(() => null);
    await load();
    await reloadProviders();
  };

  const actions: PullActions = { pull: (m) => void pull(m), pause: (m) => void pause(m), cancel: (m) => void cancel(m), remove: (m) => void remove(m) };
  const hw = status?.hardware;
  return (
    <article className="sheet">
      <div className="sheet-body local">
        <h1>{t("local.title")}</h1>
        <p className="lede">{t("local.lede")}</p>
        {hw && (
          <p className="muted local-hw">
            {hw.unified
              ? t("local.hwUnified", { ram: size(hw.ramBytes) })
              : hw.gpu
                ? t("local.hwGpu", { gpu: hw.gpu.name, vram: size(hw.gpu.vramBytes), ram: size(hw.ramBytes) })
                : t("local.hwCpu", { ram: size(hw.ramBytes) })}
          </p>
        )}
        <span id="local-part" className="visually-hidden">
          {t("local.part")}
        </span>
        <Segmented<LocalPart>
          value={part}
          labelledBy="local-part"
          onChange={setPart}
          options={[
            { value: "text", label: t("local.part.text") },
            { value: "image", label: t("local.part.image") },
            { value: "video", label: t("local.part.video") },
          ]}
        />

        {part === "text" && (
          <>
            {failed && <p className="note is-pencil">{t("local.failed")}</p>}
            {!status && !failed && <p className="muted">{t("local.checking")}</p>}
            {status && !status.installed && <InstallOllama status={status} onChange={() => void load()} />}
            {status?.installed && !status.running && <p className="note is-pencil">{t("local.notRunning")}</p>}
            {status?.running && (
              <p className="note is-ok">
                {status.managed ? t("local.runningManaged", { version: status.version ?? "" }) : t("local.running", { version: status.version ?? "" })}
              </p>
            )}

            {status && status.pulls.length > 0 && (
              <>
                <h2 className="sheet-h">{t("local.pulls")}</h2>
                <ul className="local-list">
                  {status.pulls.map((p) => (
                    <li key={p.model} className="local-row local-pull">
                      <span className="mono">{p.model}</span>
                      <PullControl model={p.model} sizeBytes={p.total} installed={false} pull={p} actions={actions} />
                    </li>
                  ))}
                </ul>
              </>
            )}

            {status && status.models.length > 0 && (
              <>
                <h2 className="sheet-h">{t("local.installed")}</h2>
                {!status.providerId && (
                  <p className="note">
                    {t("local.notConnected")}{" "}
                    <button type="button" className="link" onClick={() => void connect()}>
                      {t("local.connect")}
                    </button>
                  </p>
                )}
                <ul className="local-list">
                  {status.models.map((m) => (
                    <li key={m.name} className="local-row">
                      <span className="mono">{m.name}</span>
                      <span className="muted local-size">{size(m.sizeBytes)}</span>
                      {confirm === m.name ? (
                        <span className="local-actions">
                          <button type="button" className="btn is-pencil" onClick={() => void remove(m.name)}>
                            {t("local.removeConfirm")}
                          </button>
                          <button type="button" className="link" onClick={() => setConfirm(null)}>
                            {t("local.keep")}
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="link" onClick={() => setConfirm(m.name)}>
                          {t("local.remove")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {status?.running && <LocalCatalogView status={status} actions={actions} />}
          </>
        )}
        {part !== "text" && <LocalImagesSection key={part} kind={part} />}
      </div>
      <aside className="margin">
        <p className="note">{t("local.marginTip")}</p>
      </aside>
    </article>
  );
}
