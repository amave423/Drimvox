import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { authHeaders } from "../api";
import { useApp } from "../context";
import { CrossIcon } from "./SideChats";

interface Frame {
  data: string;
  width: number;
  height: number;
}
interface State {
  running: boolean;
  url: string;
  title: string;
}

/** Keys that are not text, passed on as keys; the rest of what is typed goes as text. */
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** The browser's state, kept fresh: whether the agent's browser runs, for the dot on the button. */
export function useBrowserState(): State | null {
  const { api } = useApp();
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    let live = true;
    const look = () =>
      void api.browser
        .$get()
        .then((r) => r.json() as Promise<State>)
        .then((s) => live && setState(s))
        .catch(() => {});
    look();
    const timer = setInterval(look, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  return state;
}

/**
 * The agent's browser in a panel of Drimvox (asked for: like Claude's, not a window jumping in front): its current tab
 * as it is now, an address to open, back and reload; clicks, scrolling and typing go into the page, so a "not a
 * robot" check is passed right here.
 */
export function BrowserPane({ onClose }: { onClose(): void }) {
  const { api, t, token } = useApp();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [state, setState] = useState<State>({ running: false, url: "", title: "" });
  const [address, setAddress] = useState("");
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const picture = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);

  // The pictures come while the panel is open, as a stream of events.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const res = await fetch("/api/browser/stream", { headers: authHeaders(token), signal: controller.signal }).catch(() => null);
      const reader = res?.body?.pipeThrough(new TextDecoderStream()).getReader();
      if (!reader) return;
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) break;
        buffer += value;
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
          const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (!data) continue;
          if (event === "frame") setFrame(JSON.parse(data) as Frame);
          if (event === "state") setState(JSON.parse(data) as State);
        }
      }
    })();
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!editing) setAddress(state.url === "about:blank" ? "" : state.url);
  }, [state.url, editing]);

  // One after another, in the order they were done (seen: typed letters overtook the click that focused the field).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send = (input: unknown) => {
    queue.current = queue.current.then(() => api.browser.input.$post({ json: input as never }).catch(() => null));
  };
  /** Where on the page the pointer is, in the page's own pixels. */
  const at = (e: { clientX: number; clientY: number }) => {
    const box = picture.current?.getBoundingClientRect();
    if (!box || !frame) return null;
    return { x: ((e.clientX - box.left) * frame.width) / box.width, y: ((e.clientY - box.top) * frame.height) / box.height };
  };
  const mouse = (action: "down" | "up" | "move", e: MouseEvent) => {
    const p = at(e);
    if (!p) return;
    if (action === "move") {
      // Moves are thinned out: a check may watch the pointer, but not every pixel of it.
      if (Date.now() - lastMove.current < 60) return;
      lastMove.current = Date.now();
    }
    send({ type: "mouse", action, ...p, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", clicks: e.detail > 0 ? Math.min(e.detail, 3) : 1 });
  };
  // Wheel events are taken over (the panel itself does not scroll under them).
  useEffect(() => {
    const el = picture.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      send({ type: "wheel", ...p, deltaX: e.deltaX, deltaY: e.deltaY });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  const key = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void navigator.clipboard.readText().then((text) => text && send({ type: "text", text }));
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (KEYS.has(e.key)) send({ type: "key", key: e.key });
    else if (e.key.length === 1) send({ type: "text", text: e.key });
    else return;
    e.preventDefault();
  };
  async function open(url?: string) {
    setFailed(false);
    const res = await api.browser.open.$post({ json: url ? { url: /^[a-z]+:/i.test(url) ? url : `https://${url}` } : {} }).catch(() => null);
    if (!res?.ok) setFailed(true);
  }

  return (
    <aside className="browser-pane" aria-label={t("browser.title")}>
      <header className="browser-bar">
        <button type="button" className="icon-button" aria-label={t("browser.back")} title={t("browser.back")} onClick={() => void api.browser.back.$post().catch(() => null)}>
          ‹
        </button>
        <button type="button" className="icon-button" aria-label={t("browser.reload")} title={t("browser.reload")} onClick={() => void api.browser.reload.$post().catch(() => null)}>
          ↻
        </button>
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            if (address.trim()) void open(address.trim());
          }}
        >
          <input
            className="field-input mono"
            aria-label={t("browser.address")}
            placeholder={t("browser.addressHint")}
            value={address}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        <button type="button" className="icon-button" aria-label={t("viewer.close")} title={t("viewer.close")} onClick={onClose}>
          <CrossIcon />
        </button>
      </header>
      <p className="browser-hint muted">{state.title ? state.title : t("browser.hint")}</p>
      <div className="browser-view" tabIndex={0} onKeyDown={key} aria-label={t("browser.view")}>
        {state.running && frame ? (
          <img
            ref={picture}
            src={`data:image/jpeg;base64,${frame.data}`}
            alt={state.title || t("browser.title")}
            draggable={false}
            onMouseDown={(e) => {
              e.currentTarget.parentElement?.focus();
              mouse("down", e);
            }}
            onMouseUp={(e) => mouse("up", e)}
            onMouseMove={(e) => mouse("move", e)}
            onContextMenu={(e) => e.preventDefault()}
          />
        ) : (
          <div className="browser-empty">
            <p>{t(state.running ? "browser.loading" : "browser.notRunning")}</p>
            {!state.running && (
              <button type="button" className="btn" onClick={() => void open()}>
                {t("browser.start")}
              </button>
            )}
            {failed && <p className="error-note">{t("browser.noBrowser")}</p>}
          </div>
        )}
      </div>
    </aside>
  );
}
