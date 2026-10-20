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
 * text runs in the desktop's hidden window and in the server's Chromium. It resolves to "keyboard" when the browser
 * must type the step's text (into the field it focused) or press its key as real input.
 */
export function pageActionScript(step: PageAction): string {
  return `(async (a) => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const wanted = norm(a.target);
  const field = () => {
    const fields = [...document.querySelectorAll("input, textarea, select, [contenteditable=true]")].filter(shown);
    const byOwn = fields.find((e) => [e.getAttribute("aria-label"), e.getAttribute("placeholder"), e.getAttribute("name"), e.id].some((v) => norm(v) === wanted));
    if (byOwn) return byOwn;
    const label = [...document.querySelectorAll("label")].find((l) => norm(l.textContent).includes(wanted));
    const own = label && (label.control || label.querySelector("input, textarea, select"));
    if (own) return own;
    const byPlaceholder = fields.find((e) => norm(e.getAttribute("placeholder")).includes(wanted));
    if (byPlaceholder) return byPlaceholder;
    // A caption that is not a <label> but plain text next to the field (seen: the WIPO trademark database).
    const captions = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && shown(e) && norm(e.textContent) === wanted);
    for (const caption of captions) {
      let box = caption.parentElement;
      for (let up = 0; box && up < 4; up++, box = box.parentElement) {
        const near = fields.find((f) => box.contains(f));
        if (near) return near;
      }
    }
    return null;
  };
  const clickable = () => {
    // A button stays disabled until the page has taken the typed text (seen: WIPO's "Search"): it is waited for.
    // A disabled exact match is waited for, not swapped for a lookalike (seen: "Advanced search" clicked instead).
    const all = [...document.querySelectorAll("button, a, [role=button], [role=link], [role=tab], [role=menuitem], summary, label, input[type=submit], input[type=button], [onclick]")].filter(shown);
    const usable = (e) => !e.disabled && e.getAttribute("aria-disabled") !== "true";
    const text = (e) => norm(e.innerText || e.value || e.getAttribute("aria-label") || e.title);
    const exact = all.filter((e) => text(e) === wanted);
    if (exact.length) return exact.find(usable) || null;
    const partial = all.filter((e) => text(e).includes(wanted));
    if (partial.length) return partial.find(usable) || null;
    return [...document.querySelectorAll("body *")].filter(shown).find((e) => e.children.length === 0 && norm(e.textContent) === wanted) || null;
  };
  const bySelector = () => { try { return document.querySelector(a.target); } catch { return null; } };
  if (a.action === "wait") { await new Promise((r) => setTimeout(r, Math.min(a.ms || 1000, ${MAX_WAIT_MS}))); return "ok"; }
  // Keys and text come from the browser itself as real input (pages ignore made-up events: seen, WIPO's search field).
  if (a.action === "press") return "keyboard";
  // Pages drawn by scripts show their fields a while after loading (seen: the WIPO database): wait for the target.
  const find = () => (a.action === "type" ? field() || bySelector() : clickable() || bySelector());
  let el = find();
  for (let waited = 0; !el && waited < ${MAX_WAIT_MS}; waited += 300) {
    await new Promise((r) => setTimeout(r, 300));
    el = find();
  }
  if (!el) throw new Error("not found on the page: " + a.target);
  el.scrollIntoView({ block: "center" });
  if (a.action === "click") { el.click(); return "ok"; }
  el.focus();
  if (el instanceof HTMLSelectElement) {
    const option = [...el.options].find((o) => norm(o.textContent) === norm(a.text) || o.value === a.text);
    if (option) el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  }
  // What was in the field is selected, so the typed text replaces it.
  if (el.select) el.select();
  else if (el.isContentEditable) document.execCommand("selectAll");
  return "keyboard";
})(${JSON.stringify(step)})`;
}

/**
 * Script run in a page to read it as a person sees it (browse_page): the title, the address after redirects and the
 * visible text, with the scripts' work done. Returns JSON.
 */
export const PAGE_TEXT_SCRIPT = `JSON.stringify({ url: location.href, title: document.title, text: document.body ? document.body.innerText : "" })`;
