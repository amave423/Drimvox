import { useEffect, useRef, useState } from "react";
import { useApp } from "../../context";

/**
 * How the model thinks. While it thinks: a line with the time and a small window of fixed height showing the
 * latest thoughts, so the page does not jump with every word. Afterwards: one folded line that opens on click.
 */
export function Reasoning({ text, thinking }: { text: string; thinking: boolean }) {
  const { t } = useApp();
  const started = useRef(Date.now());
  const [seconds, setSeconds] = useState(0);
  const [took, setTook] = useState<number | null>(null);
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!thinking) {
      if (took === null && seconds > 0) setTook(seconds);
      return;
    }
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [thinking]);

  // The window always shows the newest lines.
  useEffect(() => {
    if (tail.current) tail.current.scrollTop = tail.current.scrollHeight;
  }, [text]);

  if (thinking) {
    return (
      <div className="reasoning is-live" aria-live="off">
        <div className="reasoning-head">
          <span className="action-spinner" aria-hidden />
          {t("chat.thinking", { seconds })}
        </div>
        <div className="reasoning-tail" ref={tail}>
          {text}
        </div>
      </div>
    );
  }
  return (
    <details className="reasoning">
      <summary>{took ? t("chat.reasoningTook", { seconds: took }) : t("chat.reasoning")}</summary>
      <p>{text}</p>
    </details>
  );
}
