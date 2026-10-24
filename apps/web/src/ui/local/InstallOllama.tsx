import type { LocalStatus } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { useSize } from "./size";

const OLLAMA_DOWNLOAD = "https://ollama.com/download";

/**
 * Ollama is not on this computer: on Windows Drimvox downloads the official setup and runs it, showing the size first and
 * then the progress; elsewhere it shows the command to run, with the site as the other way.
 */
export function InstallOllama({ status, onChange }: { status: LocalStatus; onChange(): void }) {
  const { api, t } = useApp();
  const size = useSize();
  const [bytes, setBytes] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const install = status.install;
  const busy = install.state === "downloading" || install.state === "installing";

  useEffect(() => {
    if (!status.canInstall) return;
    let live = true;
    void api.local.install
      .$get()
      .then((r) => r.json())
      .then((b) => live && setBytes((b as { size: number | null }).size))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [api, status.canInstall]);

  const start = async () => {
    await api.local.install.$post().catch(() => null);
    onChange();
  };

  return (
    <div className="note is-pencil local-missing">
      <p>{t("local.notInstalled")}</p>
      {status.canInstall ? (
        <>
          {install.state === "downloading" && (
            <p className="mono">
              {install.total
                ? t("local.installProgress", { done: size(install.received), total: size(install.total), share: Math.floor((install.received / install.total) * 100) })
                : t("local.installStarted", { done: size(install.received) })}
            </p>
          )}
          {install.state === "installing" && <p>{t("local.installing")}</p>}
          {install.state === "failed" && <p className="error-note">{t(install.error === "not_found" ? "local.installNotFound" : "local.installFailed")}</p>}
          <p className="actions">
            <button type="button" className="btn is-primary" disabled={busy} onClick={() => void start()}>
              {bytes ? t("local.installSized", { size: size(bytes) }) : t("local.install")}
            </button>
            <a className="btn" href={OLLAMA_DOWNLOAD} target="_blank" rel="noreferrer">
              {t("local.download")}
            </a>
          </p>
          <p className="muted">{t("local.installHint")}</p>
        </>
      ) : (
        <>
          {status.installCommand && (
            <p className="local-command">
              <code className="mono">{status.installCommand}</code>{" "}
              <button
                type="button"
                className="link"
                onClick={() => {
                  void navigator.clipboard?.writeText(status.installCommand!);
                  setCopied(true);
                }}
              >
                {t(copied ? "local.copied" : "local.copy")}
              </button>
            </p>
          )}
          <p className="actions">
            <a className="btn is-primary" href={OLLAMA_DOWNLOAD} target="_blank" rel="noreferrer">
              {t("local.download")}
            </a>
            <button type="button" className="btn" onClick={onChange}>
              {t("local.checkAgain")}
            </button>
          </p>
        </>
      )}
    </div>
  );
}
