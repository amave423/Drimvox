/**
 * Script run in a page to learn how tall a screenshot must be to show all of it: the document, and also an element that
 * scrolls on its own (a full-screen container with overflow: auto), whose content the document's height does not count.
 * A window that tall lets such a container grow and show everything.
 */
export const PAGE_HEIGHT_SCRIPT = `(() => {
  const own = [...document.querySelectorAll("body *")].filter((e) => {
    const style = getComputedStyle(e).overflowY;
    return (style === "auto" || style === "scroll") && e.scrollHeight > e.clientHeight + 1;
  });
  const inner = own.map((e) => e.getBoundingClientRect().top + window.scrollY + e.scrollHeight);
  return Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, ...inner));
})()`;

/**
 * A step of a scenario the agent goes through on a page before it is photographed, as a person would
 * (docs/specs/project-work.md): click a button or a link, type into a field, press a key, wait.
 */
export interface PageAction {
  action: "click" | "type" | "press" | "wait";
  /** What to click or type into: its visible text, its label or placeholder, or a CSS selector. */
  target?: string;
  /** What to type, or the key to press (Enter, Escape, Tab). */
  text?: string;
  /** How long to wait, ms. */
  ms?: number;
}

/** How long one "wait" step may last. */
export const MAX_WAIT_MS = 10_000;

/**
 * Script that does one step in the page and resolves when it is done; it throws when the target is not found. The same
 * text runs in the desktop's hidden window and in the server's Chromium.
 */
export function pageActionScript(step: PageAction): string {
  return `(async (a) => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const wanted = norm(a.target);
  const field = () => {
    const fields = [...document.querySelectorAll("input, textarea, select, [contenteditable=true]")].filter(shown);
    const byOwn = fields.find((e) => [e.getAttribute("aria-label"), e.getAttribute("placeholder"), e.getAttribute("name"), e.id].some((v) => norm(v) === wanted));
    if (byOwn) return byOwn;
    const label = [...document.querySelectorAll("label")].find((l) => norm(l.textContent).includes(wanted));
    if (label) return label.control || label.querySelector("input, textarea, select");
    return fields.find((e) => norm(e.getAttribute("placeholder")).includes(wanted)) || null;
  };
  const clickable = () => {
    const all = [...document.querySelectorAll("button, a, [role=button], [role=link], [role=tab], [role=menuitem], summary, label, input[type=submit], input[type=button], [onclick]")].filter(shown);
    const text = (e) => norm(e.innerText || e.value || e.getAttribute("aria-label") || e.title);
    return all.find((e) => text(e) === wanted) || all.find((e) => text(e).includes(wanted))
      || [...document.querySelectorAll("body *")].filter(shown).find((e) => e.children.length === 0 && norm(e.textContent) === wanted) || null;
  };
  const bySelector = () => { try { return document.querySelector(a.target); } catch { return null; } };
  if (a.action === "wait") { await new Promise((r) => setTimeout(r, Math.min(a.ms || 1000, ${MAX_WAIT_MS}))); return "ok"; }
  if (a.action === "press") {
    const el = document.activeElement || document.body;
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: a.text, bubbles: true }));
    if (a.text === "Enter" && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    return "ok";
  }
  const el = a.action === "type" ? (field() || bySelector()) : (clickable() || bySelector());
  if (!el) throw new Error("not found on the page: " + a.target);
  el.scrollIntoView({ block: "center" });
  if (a.action === "click") { el.click(); return "ok"; }
  el.focus();
  if (el.isContentEditable) { el.textContent = a.text || ""; }
  else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, a.text || "");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
})(${JSON.stringify(step)})`;
}
