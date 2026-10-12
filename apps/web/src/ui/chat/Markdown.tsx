import { isValidElement, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMath } from "../../lib/markdown";
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
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: ({ node: _node, children, ...props }) => {
            const code = mermaidCode(children);
            if (code !== null && !streaming) return <Diagram code={code} />;
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});

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
