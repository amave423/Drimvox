import type { ProjectWorkView } from "@drimvox/shared";
import { useApp } from "../../context";
import { formatTokens, formatUsd } from "../../lib/format";
import { useModelInfo } from "../chat/ModelNote";

/**
 * How full the working model's context is, as a chat's margin shows it, and what the tokens went to (asked for: after a
 * run it was unclear how and on what they were spent). Every step sends the whole conversation again, so what was read
 * grows far past the context itself; the note says so.
 */
export function WorkTokens({ work }: { work: ProjectWorkView }) {
  const { t, settings } = useApp();
  const ref = work.escalated && work.models?.strong ? work.models.strong : (work.models?.work ?? null);
  const model = useModelInfo(ref);
  const { input, output, cached, context } = work.tokens;
  if (!work.startedAt || (input === 0 && output === 0 && context === null)) return null;
  const tokens = (n: number) => formatTokens(n, settings.locale);
  const size = model?.contextLength ?? null;
  return (
    <section className="work-tokens" aria-label={t("workTokens.title")}>
      <h3 className="margin-h">{t("margin.context")}</h3>
      {context !== null && size ? (
        <>
          <div className="context-bar" role="meter" aria-valuemin={0} aria-valuemax={size} aria-valuenow={Math.min(context, size)} aria-label={t("margin.context")}>
            <span style={{ width: `${Math.min(100, (context / size) * 100)}%` }} />
          </div>
          <p className="mono margin-figure">{t("margin.contextUsed", { used: tokens(context), of: tokens(size) })}</p>
        </>
      ) : (
        context !== null && <p className="mono margin-figure">{t("workTokens.contextOnly", { used: tokens(context) })}</p>
      )}
      <dl className="work-tokens-list">
        <dt>{t("workTokens.read")}</dt>
        <dd className="mono">{tokens(input)}</dd>
        {/* What the provider served from its cache, for less: none at all means the cache does not work here. */}
        <dt className="work-tokens-sub">{t("workTokens.cached")}</dt>
        <dd className="mono">{input > 0 ? t("workTokens.cachedShare", { tokens: tokens(cached), share: Math.round((cached / input) * 100) }) : tokens(cached)}</dd>
        <dt>{t("workTokens.written")}</dt>
        <dd className="mono">{tokens(output)}</dd>
        <dt>{t("workTokens.spent")}</dt>
        <dd className="mono">{formatUsd(work.spentUsd)}</dd>
      </dl>
      <p className="muted work-tokens-note">{t("workTokens.note")}</p>
    </section>
  );
}
