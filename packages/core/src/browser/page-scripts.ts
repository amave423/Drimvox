/**
 * The page as the agent reads it: its text in reading order, with every control it may use marked inline as
 * `[n kind "name"]`; `n` is what browser_click and browser_type take. The controls are kept in the page (not in its
 * markup) until the next read.
 */
export const READ_SCRIPT = `(() => {
  const refs = [];
  window.__drimvoxRefs = refs;
  const lines = [];
  let line = "";
  const flush = () => { const t = line.replace(/\\s+/g, " ").trim(); if (t) lines.push(t); line = ""; };
  const CONTROL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const nameOf = (el) => clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || (el.tagName === "SELECT" ? "" : el.innerText) || (el.tagName === "INPUT" && /^(submit|button)$/.test(el.type) ? el.value : "") || el.getAttribute("title") || el.getAttribute("alt") || (el.querySelector && el.querySelector("img[alt]") ? el.querySelector("img[alt]").alt : "")).slice(0, 80);
  const kindOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role;
    if (el.tagName === "A") return "link";
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA" || el.isContentEditable) return "field";
    if (el.tagName === "INPUT") return /^(submit|button|reset|image)$/.test(el.type) ? "button" : el.type === "checkbox" || el.type === "radio" ? el.type : "field";
    return "button";
  };
  const stateOf = (el) => {
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return el.checked ? " checked" : "";
    if (el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") return " checked";
    if (el.tagName === "SELECT") return ' value="' + clean(el.selectedOptions[0] ? el.selectedOptions[0].text : "") + '"';
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value && el.type !== "password") return ' value="' + clean(el.value).slice(0, 80) + '"';
    return el.disabled ? " disabled" : "";
  };
  const walk = (node, hidden) => {
    if (lines.length > 4000) return;
    if (node.nodeType === 3) { if (!hidden) line += node.textContent; return; }
    if (node.nodeType !== 1) return;
    const el = node;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|svg)$/i.test(el.tagName)) return;
    const style = getComputedStyle(el);
    if (style.display === "none") return;
    // A hidden box may still show its children; its own text and controls are left out.
    const unseen = style.visibility === "hidden" || style.visibility === "collapse";
    if (!unseen && el.matches(CONTROL)) {
      refs.push(el);
      line += " [" + refs.length + " " + kindOf(el) + ' "' + nameOf(el) + '"' + stateOf(el) + "] ";
      if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.getAttribute("role") === "button") return;
    }
    if (el.tagName === "IFRAME") { if (!unseen) line += " [frame] "; return; }
    if (el.tagName === "IMG" && el.alt && !unseen) line += " [image: " + clean(el.alt).slice(0, 80) + "] ";
    const block = !/^(inline|contents)/.test(style.display) || el.tagName === "BR";
    if (block) flush();
    if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c, unseen);
    for (const c of el.childNodes) walk(c, unseen);
    if (block) flush();
  };
  if (document.body) walk(document.body, false);
  flush();
  const below = Math.max(0, document.documentElement.scrollHeight - scrollY - innerHeight);
  return JSON.stringify({ url: location.href, title: document.title, text: lines.join("\\n"), below: Math.round(below) });
})()`;

/** Where control `n` from the last read is on the screen, scrolled into view; `{ error }` when it is gone. */
export const placeScript = (n: number) => `(() => {
  const el = (window.__drimvoxRefs || [])[${n - 1}];
  if (!el || !el.isConnected) return JSON.stringify({ error: "gone" });
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return JSON.stringify({ error: "hidden" });
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  return JSON.stringify({ x, y, covered: !!top && top !== el && !el.contains(top) && !top.contains(el) });
})()`;

/** Control `n` focused with its text selected, so what is typed next replaces it. */
export const focusScript = (n: number) => `(() => {
  const el = (window.__drimvoxRefs || [])[${n - 1}];
  if (!el || !el.isConnected) return false;
  el.focus();
  if (typeof el.select === "function") el.select();
  else if (el.isContentEditable) document.execCommand("selectAll");
  return true;
})()`;

/** Chooses an option of select `n` by its text or value. */
export const chooseScript = (n: number, option: string) => `(() => {
  const el = (window.__drimvoxRefs || [])[${n - 1}];
  if (!el || el.tagName !== "SELECT") return "not a select";
  const want = ${JSON.stringify(option.trim().toLowerCase())};
  const o = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.toLowerCase().includes(want));
  if (!o) return "no option like that; the options: " + [...el.options].map((o) => o.text.trim()).join(", ");
  el.value = o.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
})()`;
