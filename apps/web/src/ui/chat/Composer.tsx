import { useRef, useState, type KeyboardEvent } from "react";
import { useApp } from "../../context";

interface Props {
  disabled: boolean;
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ disabled, streaming, onSend, onStop }: Props) {
  const { t } = useApp();
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  function grow() {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    el.style.overflowY = el.scrollHeight > 240 ? "auto" : "hidden";
  }

  function submit() {
    const value = text.trim();
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
    >
      <textarea
        ref={area}
        rows={2}
        value={text}
        placeholder={t("chat.placeholder")}
        aria-label={t("chat.placeholder")}
        onChange={(e) => {
          setText(e.target.value);
          grow();
        }}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
      {streaming ? (
        <button type="button" className="btn is-pencil" onClick={onStop}>
          {t("chat.stop")}
        </button>
      ) : (
        <button className="btn is-primary" disabled={disabled || !text.trim()}>
          {t("chat.send")}
        </button>
      )}
    </form>
  );
}
