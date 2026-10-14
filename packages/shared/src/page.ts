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
