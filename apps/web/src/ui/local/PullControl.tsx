import type { LocalPull } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { useSize } from "./size";

export interface PullActions {
  pull(model: string): void;
  pause(model: string): void;
  cancel(model: string): void;
  remove(model: string): void;
}

/** "About 3 min": the time left at the speed of the last seconds. */
export function useTimeLeft(): (pull: LocalPull) => string | null {
  const { t } = useApp();
  return (p) => {
    if (!p.bytesPerSecond || p.total <= 0) return null;
    const seconds = Math.max(1, Math.round((p.total - p.completed) / p.bytesPerSecond));
    if (seconds < 60) return t("local.leftSeconds", { n: seconds });
    if (seconds < 3600) return t("local.leftMinutes", { n: Math.round(seconds / 60) });
    return t("local.leftHours", { n: (seconds / 3600).toFixed(1) });
  };
}

/** A download's error in plain words: Ollama's own text is technical (a TLS handshake, a timeout). */
export function pullError(error: string): "network" | "missing" | "unsupported" | "checksum" | "other" {
  if (/checksum/i.test(error)) return "checksum";
  if (/unknown model architecture|unsupported/i.test(error)) return "unsupported";
  if (/tls|timeout|timed out|connection|no such host|dial tcp|EOF|reset|did not answer|fetch failed/i.test(error)) return "network";
  if (/does not exist|not found|manifest/i.test(error)) return "missing";
  return "other";
}

/**
 * Everything about one model's download, where the model is listed (seen: progress shown only at the top was missed):
 * get it, the progress with the time left, pause, go on, cancel; once it is here, delete it.
 */
export function PullControl(p: { model: string; sizeBytes: number; installed: boolean; pull: LocalPull | undefined; actions: PullActions }) {
  const { t } = useApp();
  const size = useSize();
  const left = useTimeLeft();
  const [confirm, setConfirm] = useState(false);
  const pull = p.pull;

  if (pull && !pull.done) {
    const share = pull.total > 0 ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : 0;
    const time = pull.paused ? t("local.paused") : left(pull);
    return (
      <span className="pull-control">
        <span className="local-progress">
          <progress max={100} value={share} aria-label={t("local.progress", { model: p.model })} />
          <span className="muted">
            {pull.total > 0 ? t("local.pullBytes", { done: size(pull.completed), total: size(pull.total), share }) : pull.status}
            {time ? ` · ${time}` : ""}
          </span>
        </span>
        {pull.paused ? (
          <button type="button" className="btn" onClick={() => p.actions.pull(p.model)}>
            {t("local.resume")}
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => p.actions.pause(p.model)}>
            {t("local.pause")}
          </button>
        )}
        <button type="button" className="link" onClick={() => p.actions.cancel(p.model)}>
          {t("local.cancel")}
        </button>
      </span>
    );
  }
  if (pull?.error) {
    return (
      <span className="pull-control">
        <span className="is-pencil-text" title={pull.error}>
          {t(`local.pullError.${pullError(pull.error)}`)}
        </span>
        <button type="button" className="btn" onClick={() => p.actions.pull(p.model)}>
          {t("local.retry")}
        </button>
      </span>
    );
  }
  if (p.installed || pull?.done) {
    return (
      <span className="pull-control">
        <span className="is-ok-text">{t("local.have", { size: size(p.sizeBytes) })}</span>
        {confirm ? (
          <>
            <button type="button" className="btn is-pencil" onClick={() => p.actions.remove(p.model)}>
              {t("local.removeConfirm")}
            </button>
            <button type="button" className="link" onClick={() => setConfirm(false)}>
              {t("local.keep")}
            </button>
          </>
        ) : (
          <button type="button" className="link" onClick={() => setConfirm(true)}>
            {t("local.remove")}
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="pull-control">
      <button type="button" className="btn" onClick={() => p.actions.pull(p.model)}>
        {t("local.get", { size: size(p.sizeBytes) })}
      </button>
    </span>
  );
}
