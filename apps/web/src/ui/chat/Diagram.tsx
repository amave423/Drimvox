import { useEffect, useId, useState } from "react";
import { useApp } from "../../context";
import { DiagramViewer } from "./DiagramViewer";

type MermaidApi = typeof import("mermaid").default;
let loading: Promise<MermaidApi> | null = null;

/** Mermaid is large; it loads the first time an answer has a diagram. */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

/**
 * A token as #rrggbb. Mermaid reads only plain colours; the dark theme's tokens are color-mix() of the mark's colours
 * (seen: every diagram failed in the dark theme), so the browser works the colour out and a canvas reads it back.
 */
function plainColour(value: string): string {
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return value;
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  ctx.fillStyle = getComputedStyle(probe).color;
  probe.remove();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
}

/** Colours of diagrams come from the theme tokens, so they follow light and dark mode. */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => (name === "--font-ui" ? css.getPropertyValue(name).trim() : plainColour(css.getPropertyValue(name).trim()));
  return {
    darkMode: document.documentElement.dataset.theme === "dark",
    background: v("--sheet"),
    primaryColor: v("--ink-soft"),
    primaryBorderColor: v("--ink"),
    primaryTextColor: v("--fg"),
    secondaryColor: v("--ok-soft"),
    tertiaryColor: v("--wait-soft"),
    lineColor: v("--muted"),
    edgeLabelBackground: v("--sheet"),
    textColor: v("--fg"),
    mainBkg: v("--ink-soft"),
    nodeBorder: v("--ink"),
    fontFamily: v("--font-ui"),
    pie1: v("--ink"),
    pie2: v("--ok"),
    pie3: v("--wait"),
    pie4: v("--pencil"),
    pie5: v("--muted"),
    pieStrokeColor: v("--sheet"),
    pieTitleTextColor: v("--fg"),
    pieSectionTextColor: v("--sheet"),
    pieLegendTextColor: v("--fg"),
  };
}

/** A Mermaid diagram or chart from a model's answer; the code stays visible when it cannot be drawn. */
export function Diagram({ code }: { code: string }) {
  const { t, settings } = useApp();
  const id = `d${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    void loadMermaid()
      .then(async (mermaid) => {
        // "strict" keeps scripts and links out of diagrams a model wrote.
        // Labels as SVG text rather than HTML, so a diagram also saves as PNG.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVariables(), htmlLabels: false, flowchart: { htmlLabels: false } });
        const { svg } = await mermaid.render(id, code);
        if (live) setSvg(svg);
      })
      .catch(() => {
        // Mermaid leaves its error drawing in the page; remove it.
        document.getElementById(`d${id}`)?.remove();
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [code, id, settings.theme]);

  if (failed || svg === null) {
    return (
      <figure className="diagram">
        <pre>
          <code>{code}</code>
        </pre>
        {failed && <figcaption className="muted">{t("chat.diagramFailed")}</figcaption>}
      </figure>
    );
  }
  // Mermaid's own sanitiser has cleaned the SVG ("strict" mode). A click opens it over the window, to zoom and save.
  return (
    <figure className="diagram">
      <button type="button" className="diagram-open" aria-label={t("diagram.open")} title={t("diagram.open")} onClick={() => setOpen(true)} dangerouslySetInnerHTML={{ __html: svg }} />
      {open && <DiagramViewer svg={svg} onClose={() => setOpen(false)} />}
    </figure>
  );
}
