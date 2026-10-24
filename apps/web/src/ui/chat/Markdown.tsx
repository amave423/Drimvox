import { isValidElement, memo, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useApp } from "../../context";
import { normalizeMath } from "../../lib/markdown";
import { siteIcon } from "../../lib/siteIcons";
import { Diagram } from "./Diagram";

interface Props {
  text: string;
  /** While the answer is still coming, diagrams stay as code: half a diagram cannot be drawn. */
  streaming?: boolean;
}

/**
 * Model answers as Markdown: tables, formulas (KaTeX), highlighted code and Mermaid diagrams and charts.
 * Links open in the system browser; raw HTML is not rendered.
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: false }]]}
        components={{
          a: ({ node: _node, children, ...props }) => <SiteLink props={props}>{children}</SiteLink>,
          pre: ({ node: _node, children, ...props }) => {
            const code = mermaidCode(children);
            if (code !== null && !streaming) return <Diagram code={code} />;
            return <CodeBlock props={props}>{children}</CodeBlock>;
          },
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A link stands out from the text, and a popular site's link carries its mark (seen: links in answers were hard to tell
 * from the words around them). Opens in the system browser.
 */
function SiteLink({ props, children }: { props: ComponentProps<"a">; children: ReactNode }) {
  const icon = siteIcon(props.href);
  return (
    <a {...props} className="md-link" target="_blank" rel="noreferrer" title={props.href}>
      {icon && (
        <svg className="md-link-icon" viewBox="0 0 24 24" aria-hidden>
          <path d={icon.path} />
        </svg>
      )}
      {children}
    </a>
  );
}

/** A code block with its language and a button that copies the code. */
function CodeBlock({ props, children }: { props: ComponentProps<"pre">; children: ReactNode }) {
  const { t } = useApp();
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const language = isValidElement(child) ? /\blanguage-([\w+#-]+)/.exec((child as ReactElement<{ className?: string }>).props.className ?? "")?.[1] : undefined;
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="mono muted">{language ?? ""}</span>
        <button
          type="button"
          className="code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(textOf(children).replace(/\n$/, ""));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {t(copied ? "code.copied" : "code.copy")}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

/** The source of a ```mermaid block, or null for any other code. */
function mermaidCode(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return null;
  const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
  if (!/\blanguage-mermaid\b/.test(props.className ?? "")) return null;
  return textOf(props.children).trim();
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}
