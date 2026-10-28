import { useEffect, useRef, useState } from "react";
import { authHeaders } from "../api";
import { useApp } from "../context";
import { CrossIcon } from "./SideChats";
import { BrowserView, type BrowserFrameView } from "./BrowserView";

const WIDTH_KEY = "drimvox.browserWidth";
const keptWidth = () => {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || 0;
  } catch {
    return 0;
  }
};

interface Tab {
  id: string;
  url: string;
  title: string;
}
interface State {
  running: boolean;
  url: string;
  title: string;
  tabs: Tab[];
  active: string | null;
}

/** A tab's name in the strip: its title, else its address without the scheme. */
const tabName = (tab: Tab, blank: string) => tab.title.trim() || (tab.url === "about:blank" ? blank : tab.url.replace(/^https?:\/\//, ""));

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
 * The agent's browser in a panel of Drimvox (asked for: like Claude's, a browser and not a picture of one): its tabs,
 * an address, back and reload, and the page at the panel's own size, to click, drag, scroll and type in — a "not a
 * robot" check is passed right here. The panel is widened by its edge or opened over the whole window.
 */
export function BrowserPane({ onClose }: { onClose(): void }) {
  const { api, t, token } = useApp();
  const [frame, setFrame] = useState<BrowserFrameView | null>(null);
  const [state, setState] = useState<State>({ running: false, url: "", title: "", tabs: [], active: null });
  const [address, setAddress] = useState("");
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [width, setWidth] = useState(keptWidth);
  const [wide, setWide] = useState(false);
  const dragging = useRef(false);

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
          if (event === "frame") setFrame(JSON.parse(data) as BrowserFrameView);
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
  async function open(url?: string) {
    setFailed(false);
    const res = await api.browser.open.$post({ json: url ? { url: /^[a-z]+:/i.test(url) ? url : `https://${url}` } : {} }).catch(() => null);
    if (!res?.ok) setFailed(true);
  }

  return (
    <aside className={`browser-pane${wide ? " is-wide" : ""}`} aria-label={t("browser.title")} style={wide || !width ? undefined : { width }}>
      {/* The panel's left edge: dragged, it widens or narrows the panel. */}
      <div
        className="browser-edge"
        aria-hidden
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          setWide(false);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          setWidth(Math.min(Math.max(window.innerWidth - e.clientX, 420), window.innerWidth - 80));
        }}
        onPointerUp={() => {
          dragging.current = false;
          try {
            localStorage.setItem(WIDTH_KEY, String(width));
          } catch {
            // Kept for this visit only.
          }
        }}
      />
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
        <button type="button" className="icon-button" aria-pressed={wide} aria-label={t(wide ? "browser.narrow" : "browser.wide")} title={t(wide ? "browser.narrow" : "browser.wide")} onClick={() => setWide(!wide)}>
          {wide ? "⤡" : "⤢"}
        </button>
        <button type="button" className="icon-button" aria-label={t("viewer.close")} title={t("viewer.close")} onClick={onClose}>
          <CrossIcon />
        </button>
      </header>
      {state.running && state.tabs.length > 0 && (
        // The agent may open several tabs: all of them, the shown one marked (asked for: a switch between them).
        <div className="browser-tabs" role="tablist" aria-label={t("browser.tabs")}>
          {state.tabs.map((tab) => (
            <div key={tab.id} className={`browser-tab${tab.id === state.active ? " is-on" : ""}`}>
              <button type="button" role="tab" aria-selected={tab.id === state.active} title={tab.url} onClick={() => void api.browser.tab.$post({ json: { id: tab.id } }).catch(() => null)}>
                {tabName(tab, t("browser.blank"))}
              </button>
              <button type="button" className="browser-tab-close" aria-label={t("browser.closeTab", { name: tabName(tab, t("browser.blank")) })} onClick={() => void api.browser.tab.close.$post({ json: { id: tab.id } }).catch(() => null)}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="browser-tab-new" aria-label={t("browser.newTab")} title={t("browser.newTab")} onClick={() => void api.browser.tab.new.$post({ json: {} }).catch(() => null)}>
            +
          </button>
        </div>
      )}
      {state.running ? (
        <BrowserView frame={frame} title={state.title || t("browser.title")} onInput={send} />
      ) : (
        <div className="browser-empty">
          <p>{t("browser.hint")}</p>
          <p className="muted">{t("browser.notRunning")}</p>
          <button type="button" className="btn" onClick={() => void open()}>
            {t("browser.start")}
          </button>
          {failed && <p className="error-note">{t("browser.noBrowser")}</p>}
        </div>
      )}
    </aside>
  );
}
