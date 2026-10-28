import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useApp } from "../context";

export interface BrowserFrameView {
  data: string;
  /** The page's size in CSS pixels; the picture is `scale` times larger. */
  width: number;
  height: number;
  scale: number;
}

/** Keys that are not text; letters and the rest arrive as text through the hidden field. */
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

/**
 * The page itself (asked for: a browser, not a picture squeezed into a panel): the agent's browser takes this box's size,
 * so the page fills it one to one, sharp on a dense screen. The pointer, the wheel and the keyboard go into the page —
 * drags and selections too; text comes through a hidden field, so any layout, input method and pasting work.
 */
export function BrowserView({ frame, title, onInput }: { frame: BrowserFrameView | null; title: string; onInput(input: unknown): void }) {
  const { api } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const lastMove = useRef(0);

  // The browser follows the box's size, a moment after it settles.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tell = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const width = Math.round(el.clientWidth);
        const height = Math.round(el.clientHeight);
        if (width > 100 && height > 100) void api.browser.size.$post({ json: { width, height, scale: Math.min(Math.max(window.devicePixelRatio || 1, 1), 3) } }).catch(() => null);
      }, 150);
    };
    tell();
    const observer = new ResizeObserver(tell);
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [api]);

  /** Where on the page the pointer is, in the page's own pixels. */
  const at = (e: { clientX: number; clientY: number }) => {
    const rect = box.current?.querySelector("img")?.getBoundingClientRect();
    if (!rect || !frame || !rect.width || !rect.height) return null;
    return { x: ((e.clientX - rect.left) * frame.width) / rect.width, y: ((e.clientY - rect.top) * frame.height) / rect.height };
  };
  const button = (b: number) => (b === 2 ? "right" : b === 1 ? "middle" : "left");

  // The wheel scrolls the page, not the panel.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      onInput({ type: "wheel", ...p, deltaX: e.deltaX, deltaY: e.deltaY });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  const down = (e: PointerEvent<HTMLImageElement>) => {
    const p = at(e);
    if (!p) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    keys.current?.focus();
    onInput({ type: "mouse", action: "down", ...p, button: button(e.button), clicks: Math.min(Math.max(e.detail, 1), 3), buttons: e.buttons });
  };
  const move = (e: PointerEvent<HTMLImageElement>) => {
    const p = at(e);
    if (!p) return;
    // A drag is followed closely; a plain move only now and then (a check may watch the pointer, not every pixel).
    const gap = e.buttons ? 16 : 50;
    if (Date.now() - lastMove.current < gap) return;
    lastMove.current = Date.now();
    onInput({ type: "mouse", action: "move", ...p, buttons: e.buttons });
  };
  const up = (e: PointerEvent<HTMLImageElement>) => {
    const p = at(e);
    if (!p) return;
    onInput({ type: "mouse", action: "up", ...p, button: button(e.button), clicks: Math.min(Math.max(e.detail, 1), 3), buttons: e.buttons });
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Pasting and plain letters come as text through the field; named keys and shortcuts go as keys.
    const shortcut = (e.ctrlKey || e.metaKey) && e.key.length === 1;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    if (!KEYS.has(e.key) && !shortcut) return;
    e.preventDefault();
    onInput({ type: "key", key: e.key, modifiers: modifiers(e) });
  };

  return (
    <div className="browser-view" ref={box}>
      {frame ? (
        <img
          src={`data:image/jpeg;base64,${frame.data}`}
          alt={title}
          draggable={false}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onContextMenu={(e) => e.preventDefault()}
        />
      ) : null}
      <textarea
        ref={keys}
        className="browser-keys"
        aria-label={title}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={key}
        onCompositionEnd={(e) => {
          const text = e.currentTarget.value;
          e.currentTarget.value = "";
          if (text) onInput({ type: "text", text });
        }}
        onInput={(e) => {
          // An input method composes a word first: it goes when the word is done.
          if ((e.nativeEvent as InputEvent).isComposing) return;
          const text = e.currentTarget.value;
          e.currentTarget.value = "";
          if (text) onInput({ type: "text", text });
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text");
          if (text) onInput({ type: "text", text });
        }}
      />
    </div>
  );
}

/**
 * The desktop's page box (asked for: a browser exactly like Claude's): the agent's real tab is put over it by the app,
 * so clicks, typing, scrolling and checks are the browser's own. The box tells where it is whenever it moves.
 */
export function EmbeddedView({ title, paused }: { title: string; paused: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // A press anywhere on Drimvox's own page takes the keyboard back from the tab.
  useEffect(() => {
    const take = () => window.drimvox?.focusPage?.();
    document.addEventListener("pointerdown", take, true);
    return () => document.removeEventListener("pointerdown", take, true);
  }, []);
  useEffect(() => {
    const el = box.current;
    const place = window.drimvox?.placeBrowser;
    if (!el || !place) return;
    // The panel's edge is dragged: the tab steps aside, or it would take the pointer over it.
    if (paused) {
      place(null);
      return;
    }
    let last = "";
    const tell = () => {
      const r = el.getBoundingClientRect();
      const now = { x: r.left, y: r.top, width: r.width, height: r.height };
      const key = JSON.stringify(now);
      if (key === last) return;
      last = key;
      place(now);
    };
    // The panel slides in and is dragged wider: its box is followed as long as it is open.
    let frame = requestAnimationFrame(function follow() {
      tell();
      frame = requestAnimationFrame(follow);
    });
    return () => {
      cancelAnimationFrame(frame);
      place(null);
    };
  }, [paused]);
  return <div className="browser-view is-embedded" ref={box} aria-label={title} />;
}
