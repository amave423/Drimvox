import type { FileTouch } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authHeaders } from "../../api";
import { useApp } from "../../context";
import { dimTitleBar } from "../../theme";
import { CrossIcon } from "../SideChats";
import { Markdown } from "./Markdown";

const PICTURE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** The language for highlighting, from the file's extension. */
function language(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  return { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", py: "python", cs: "csharp", md: "markdown", yml: "yaml", sh: "bash", ps1: "powershell" }[ext] ?? ext;
}

/** A file of the chat's folder over the window: code highlighted, a picture as a picture. */
export function FileViewer({ chatId, path, onClose }: { chatId: string; path: string; onClose(): void }) {
  const { t, token } = useApp();
  const [state, setState] = useState<{ text?: string; picture?: string; error?: string } | null>(null);

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    void fetch(`/api/chats/${chatId}/file?path=${encodeURIComponent(path)}`, { headers: authHeaders(token) })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? t("files.gone") : res.status === 413 ? t("files.tooBig") : t("files.failed"));
        if (PICTURE.test(path)) {
          url = URL.createObjectURL(await res.blob());
          if (live) setState({ picture: url });
        } else {
          const text = await res.text();
          if (live) setState({ text });
        }
      })
      .catch((err: unknown) => live && setState({ error: err instanceof Error ? err.message : t("files.failed") }));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [chatId, path, token, t]);

  useEffect(() => {
    dimTitleBar(true, "--overlay");
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      dimTitleBar(false, "--overlay");
    };
  }, [onClose]);

  // A fence longer than any run of backticks in the file, so the file cannot end it early.
  const fence = "`".repeat(Math.max(3, ...[...(state?.text ?? "").matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={path} onClick={onClose}>
      <section className="file-view" onClick={(e) => e.stopPropagation()}>
        <header className="file-view-head">
          <span className="mono">{path}</span>
          <button type="button" className="file-view-close" aria-label={t("viewer.close")} title={t("viewer.close")} onClick={onClose}>
            <CrossIcon />
          </button>
        </header>
        <div className="file-view-body">
          {!state && <p className="muted">{t("files.loading")}</p>}
          {state?.error && <p className="muted">{state.error}</p>}
          {state?.picture && <img src={state.picture} alt={path} />}
          {state?.text !== undefined && <Markdown text={`${fence}${language(path)}\n${state.text.replace(/\n$/, "")}\n${fence}`} />}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** The files an answer wrote, changed or read: each opens to look at (asked for, from the "workbench" design). */
export function FileChips({ chatId, files }: { chatId: string; files: { path: string; touch: FileTouch }[] }) {
  const { t } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  if (files.length === 0) return null;
  return (
    <div className="file-chips">
      {files.map((f) => (
        <button key={f.path} type="button" className={`file-chip is-${f.touch}`} title={t("files.open", { path: f.path })} onClick={() => setOpen(f.path)}>
          <span className="mono">{f.path.split("/").pop()}</span>
          <span className="file-chip-touch">{t(`files.touch.${f.touch}`)}</span>
        </button>
      ))}
      {open && <FileViewer chatId={chatId} path={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
