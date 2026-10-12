import { useEffect, useId, useState } from "react";
import { useApp } from "../../context";

type MermaidApi = typeof import("mermaid").default;
let loading: Promise<MermaidApi> | null = null;

/** Mermaid is large; it loads the first time an answer has a diagram. */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

/** Colours of diagrams come from the theme tokens, so they follow light and dark mode. */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: document.documentElement.dataset.theme === "dark",
    background: v("--sheet"),
    primaryColor: v("--ink-soft"),
    primaryBorderColor: v("--ink"),
    primaryTextColor: v("--fg"),
    secondaryColor: v("--ok-soft"),
    tertiaryColor: v("--wait-soft"),
    lineColor: v("--muted"),
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

  useEffect(() => {
    let live = true;
    setFailed(false);
    void loadMermaid()
      .then(async (mermaid) => {
        // "strict" keeps scripts and links out of diagrams a model wrote.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVariables() });
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
  // Mermaid's own sanitiser has cleaned the SVG ("strict" mode).
  return <figure className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
