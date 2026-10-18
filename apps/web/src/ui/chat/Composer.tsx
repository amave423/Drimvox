import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useApp } from "../../context";
import { PendingFiles, type PendingFile } from "./Attachments";

interface Props {
  disabled: boolean;
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
  /** Controls shown under the text field, e.g. the model picker. */
  tools?: ReactNode;
  /** A row between the text field and the controls, e.g. picture options. */
  extra?: ReactNode;
  /** Replaces "Send", e.g. with the price of a clip. */
  sendLabel?: string;
  placeholder?: string;
  /** Files may be attached: the 📎 button, dropping them on the field, pasting a picture. */
  attach?: { files: PendingFile[]; onAdd(files: File[]): void; onRemove(key: string): void };
}

export function Composer({ disabled, streaming, onSend, onStop, tools, extra, sendLabel, placeholder, attach }: Props) {
  const { t } = useApp();
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
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

  return (
    <form
      className="composer"
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
        disabled={disabled}
      />
      {extra}
      <div className="composer-bar">
        {attach && (
          <>
            <button type="button" className="attach-button" aria-label={t("attach.add")} title={t("attach.add")} disabled={disabled || streaming} onClick={() => picker.current?.click()}>
              📎
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                attach.onAdd([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </>
        )}
        {tools}
        <span className="spacer" />
        {streaming ? (
          <button type="button" className="btn is-pencil" onClick={onStop}>
            {t("chat.stop")}
          </button>
        ) : (
          <button className="btn is-primary" disabled={disabled || (!text.trim() && !hasFiles)}>
            {sendLabel ?? t("chat.send")}
          </button>
        )}
      </div>
    </form>
  );
}
