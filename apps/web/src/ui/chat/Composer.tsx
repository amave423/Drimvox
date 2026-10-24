import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useApp } from "../../context";
import { PendingFiles, type PendingFile } from "./Attachments";
import { ChatOptions, type OptionRow } from "./ChatOptions";

/** Below this width the model and the paperclip move into Options, so the bar stays one tidy row. */
const NARROW = 480;

interface Props {
  /** Nothing can be sent yet (no model chosen, say); the text can still be written (seen: typing waited for a model). */
  disabled: boolean;
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
  /** The model picker, under the text field. */
  picker: ReactNode;
  /** What goes into the Options panel, and what differs from the usual (shown on its button). */
  options: { rows: OptionRow[]; changed: string[] };
  /** A row between the text field and the controls, e.g. picture options. */
  extra?: ReactNode;
  /** Next to the send button, e.g. what a picture will cost. */
  beforeSend?: ReactNode;
  /** Replaces "Send", e.g. with the price of a clip. */
  sendLabel?: string;
  placeholder?: string;
  /** Files may be attached: the paperclip button, dropping them on the field, pasting a picture. */
  /**
   * Files to send. `photos`: a picture or video chat, where only photos go; `blocked`: why the paperclip is off (the
   * model takes no photos), shown on it instead of hiding it.
   */
  attach?: { files: PendingFile[]; onAdd(files: File[]): void; onRemove(key: string): void; photos?: boolean; blocked?: string };
}

export function Composer({ disabled, streaming, onSend, onStop, picker, options, extra, beforeSend, sendLabel, placeholder, attach }: Props) {
  const { t } = useApp();
  const form = useRef<HTMLFormElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = form.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const hasFiles = !!attach && attach.files.length > 0;

  function grow() {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    el.style.overflowY = el.scrollHeight > 240 ? "auto" : "hidden";
  }

  function submit() {
    // A file alone is a message too: the model is asked to look at it.
    const value = text.trim() || (hasFiles ? t("attach.default") : "");
    if (!value || disabled || streaming) return;
    onSend(value);
    setText("");
    requestAnimationFrame(grow);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const attachButton = attach && (
    <button
      type="button"
      className="attach-button"
      aria-label={attach.blocked ? `${t("attach.add")}: ${attach.blocked}` : t(attach.photos ? "attach.photo" : "attach.add")}
      title={attach.blocked ?? t(attach.photos ? "attach.photo" : "attach.add")}
      disabled={disabled || streaming || !!attach.blocked}
      onClick={() => filePicker.current?.click()}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
      </svg>
    </button>
  );

  return (
    <form
      ref={form}
      className={`composer${narrow ? " is-narrow" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => attach && e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!attach || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        attach.onAdd([...e.dataTransfer.files]);
      }}
    >
      {attach && <PendingFiles files={attach.files} onRemove={attach.onRemove} />}
      <textarea
        ref={area}
        rows={2}
        value={text}
        placeholder={placeholder ?? t("chat.placeholder")}
        aria-label={placeholder ?? t("chat.placeholder")}
        onChange={(e) => {
          setText(e.target.value);
          grow();
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (!attach || files.length === 0) return;
          e.preventDefault();
          attach.onAdd(files);
        }}
      />
      {extra}
      {attach && (
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          accept={attach.photos ? "image/*" : undefined}
          onChange={(e) => {
            attach.onAdd([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      )}
      {/* One row: the tools take what room there is, the send button keeps to the right edge of the field (seen: on a
          narrow window the buttons wrapped into a heap and the send button jumped between rows). */}
      <div className="composer-bar">
        <div className="composer-tools">
          {attach && !narrow && attachButton}
          {!narrow && picker}
          {(narrow || options.rows.length > 0) && (
            <ChatOptions
              narrow={narrow}
              rows={
                narrow
                  ? [{ label: t("options.model"), control: picker }, ...(attach ? [{ label: t("options.files"), control: attachButton }] : []), ...options.rows]
                  : options.rows
              }
              changed={options.changed}
            />
          )}
        </div>
        {beforeSend}
        {streaming ? (
          <button type="button" className="btn is-pencil composer-send" onClick={onStop}>
            {t("chat.stop")}
          </button>
        ) : (
          <button className="btn is-primary composer-send" disabled={disabled || (!text.trim() && !hasFiles)}>
            {sendLabel ?? t("chat.send")}
          </button>
        )}
      </div>
    </form>
  );
}
