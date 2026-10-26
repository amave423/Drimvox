import type { DiffFile, DiffLine } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import { useAuthorizedUrl } from "../../lib/media";

export interface LineComment {
  path: string;
  line: number;
  /** "old": a removed line, numbered as in the original file. */
  side: "old" | "new";
  text: string;
}

interface Props {
  /** Pictures in the review are shown from the task's branch; without one (a task done in the project's folder) they are named only. */
  taskId?: string;
  files: DiffFile[];
  comments: LineComment[];
  /** Absent when the review is closed: lines are then read-only. */
  onComment?(comment: LineComment): void;
  /** Files listed folded, each opened on its own (asked for: a whole project's changes open at once weighed the app down). */
  folded?: boolean;
}

/** The agent's changes as proofreading: removed text struck in red pencil, added text in ink. */
export function DiffView({ taskId, files, comments, onComment, folded }: Props) {
  return (
    <div className="diff">
      {files.map((file) => (
        <DiffFileView key={file.path} taskId={taskId} file={file} comments={comments} onComment={onComment} folded={!!folded} />
      ))}
    </div>
  );
}

/** One file's changes; folded, only its name and counts, its lines drawn once it is opened. */
function DiffFileView({ taskId, file, comments, onComment, folded }: Omit<Props, "files" | "folded"> & { file: DiffFile; folded: boolean }) {
  const { t } = useApp();
  const [open, setOpen] = useState(!folded);
  const name = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const counts = (
    <span className="mono diff-count">
      <span className="is-ink">+{file.added}</span> <span className="is-pencil-text">−{file.removed}</span>
    </span>
  );
  return (
    <section className={`diff-file${folded && !open ? " is-folded" : ""}`}>
      {folded ? (
        <button
          type="button"
          className="diff-head diff-toggle"
          aria-expanded={open}
          aria-label={t(open ? "diff.hide" : "diff.show", { path: file.path })}
          onClick={() => setOpen(!open)}
        >
          <span className="diff-caret" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <span className="mono">{name}</span>
          {counts}
        </button>
      ) : (
        <header className="diff-head">
          <span className="mono">{name}</span>
          {counts}
        </header>
      )}
      {!open ? null : taskId && file.binary && IMAGE.test(file.path) && file.status !== "deleted" ? (
        <DiffImage taskId={taskId} path={file.path} />
      ) : file.binary ? (
        <p className="muted diff-binary">{t("review.binary")}</p>
      ) : (
        file.hunks.map((hunk, h) => (
          <div key={h} className="diff-hunk">
            {hunk.lines.map((line, i) => (
              <Line
                key={i}
                path={file.path}
                line={line}
                comments={comments.filter((c) => c.path === file.path && c.side === sideOf(line) && c.line === lineNumber(line))}
                onComment={onComment}
              />
            ))}
          </div>
        ))
      )}
    </section>
  );
}

function lineNumber(line: DiffLine): number {
  return line.newLine ?? line.oldLine ?? 0;
}

function sideOf(line: DiffLine): LineComment["side"] {
  return line.kind === "del" ? "old" : "new";
}

function Line({ path, line, comments, onComment }: { path: string; line: DiffLine; comments: LineComment[]; onComment?: Props["onComment"] }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const no = lineNumber(line);

  return (
    <>
      <div
        className={`dl dl-${line.kind}${onComment ? " is-commentable" : ""}`}
        onClick={() => onComment && setOpen(true)}
        role={onComment ? "button" : undefined}
        tabIndex={onComment ? 0 : undefined}
        aria-label={onComment ? `${path}:${no}` : undefined}
        onKeyDown={(e) => {
          if (onComment && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="dl-no">{no || ""}</span>
        <span className="dl-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
        <code className="dl-text">{line.text || " "}</code>
      </div>
      {comments.map((c, i) => (
        <p key={i} className="dl-comment">
          {c.text}
        </p>
      ))}
      {open && onComment && (
        <form
          className="dl-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onComment({ path, line: no, side: sideOf(line), text: text.trim() });
            setText("");
            setOpen(false);
          }}
        >
          <textarea
            className="field-input"
            rows={2}
            autoFocus
            value={text}
            placeholder={t("review.commentPlaceholder")}
            aria-label={t("review.commentPlaceholder")}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="actions">
            <button className="btn is-primary" disabled={!text.trim()}>
              {t("review.addComment")}
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              {t("review.cancel")}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;

/** A new or changed picture, shown as it is on the task's branch. */
function DiffImage({ taskId, path }: { taskId: string; path: string }) {
  const { token } = useApp();
  const src = useAuthorizedUrl(`/api/tasks/${taskId}/file?path=${encodeURIComponent(path)}`, token);
  return <div className="diff-image">{src ? <img src={src} alt={path} /> : <div className="media-wait" aria-busy />}</div>;
}
