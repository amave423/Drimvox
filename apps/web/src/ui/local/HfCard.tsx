import type { ReactNode } from "react";
import { useApp } from "../../context";

/**
 * A model found on Hugging Face, as a card: its maker and name on their own lines, so a long name wraps instead of
 * pushing the numbers about (seen: every row jumped with the length of the name); a link to its page there; its files
 * open inside the card, across the whole row.
 */
export function HfCard(p: { repo: string; facts: string; badge?: ReactNode; why?: string | null; open: boolean; onToggle(): void; children?: ReactNode }) {
  const { t } = useApp();
  const slash = p.repo.indexOf("/");
  const owner = slash > 0 ? p.repo.slice(0, slash) : "";
  const name = slash > 0 ? p.repo.slice(slash + 1) : p.repo;
  return (
    <li className={`hf-card local-repo${p.open ? " is-open" : ""}${p.why ? " is-unsupported" : ""}`}>
      <div className="hf-card-name">
        {owner && <span className="hf-card-owner">{owner}/</span>}
        <span className="hf-card-repo">{name}</span>
      </div>
      {p.badge}
      <p className="hf-card-facts">{p.facts}</p>
      {p.why && <p className="local-why">{p.why}</p>}
      <div className="hf-card-foot">
        {!p.why && (
          <button type="button" className="link" aria-expanded={p.open} aria-label={`${t(p.open ? "local.filesHide" : "local.files")}: ${p.repo}`} onClick={p.onToggle}>
            {t(p.open ? "local.filesHide" : "local.files")}
          </button>
        )}
        <a className="link hf-card-link" href={`https://huggingface.co/${p.repo}`} target="_blank" rel="noreferrer">
          {t("local.onHf")}
        </a>
      </div>
      {p.open && <div className="hf-card-files">{p.children}</div>}
    </li>
  );
}
