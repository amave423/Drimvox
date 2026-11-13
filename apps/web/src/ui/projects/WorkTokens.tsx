import type { ProjectWorkView } from "@drimvox/shared";
import { Fragment } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { formatPrice, formatTokens, formatUsd } from "../../lib/format";
import { useModelInfo } from "../chat/ModelNote";
import { hoursAndMinutes } from "./useProjectWork";

/**
 * How full the working model's context is, as a chat's margin shows it, and what the tokens went to (asked for: after a
 * run it was unclear how and on what they were spent). Every step sends the whole conversation again, so what was read
 * grows far past the context itself; the note says so.
 */
/** The context counts as long from here: each message reads it whole again, so a new task costs far more in it. */
const LONG_SHARE = 0.4;
const LONG_TOKENS = 60_000;

export function WorkTokens({ work, onFresh }: { work: ProjectWorkView; /** A ready project's next task in a new conversation. */ onFresh?: () => void }) {
  const { t, settings } = useApp();
  const ref = work.escalated && work.models?.strong ? work.models.strong : (work.models?.work ?? null);
  const model = useModelInfo(ref);
  const { input, output, cached, context } = work.tokens;
  if (!work.startedAt || (input === 0 && output === 0 && context === null)) return null;
  const tokens = (n: number) => formatTokens(n, settings.locale);
  const split = moneyByKind(work);
  const size = model?.contextLength ?? null;
  return (
    <section className="work-tokens" aria-label={t("workTokens.title")}>
      <h3 className="margin-h">{t("margin.context")}</h3>
      {context !== null && size ? (
        <>
          <div
            className="context-bar"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={size}
            aria-valuenow={Math.min(context, size)}
            aria-label={t("margin.context")}
          >
            <span style={{ width: `${Math.min(100, (context / size) * 100)}%` }} />
          </div>
          <p className="mono margin-figure">{t("margin.contextUsed", { used: tokens(context), of: tokens(size) })}</p>
        </>
      ) : (
        context !== null && <p className="mono margin-figure">{t("workTokens.contextOnly", { used: tokens(context) })}</p>
      )}
      <dl className="work-tokens-list">
        {/* Asked for: reading, the cache apart from it, writing; the tokens, the money and the rate of each. */}
        {split.map((row) => (
          <Fragment key={row.key}>
            <dt>{t(row.label)}</dt>
            <dd className="mono">
              {row.money === null ? tokens(row.tokens) : t("workTokens.amount", { tokens: tokens(row.tokens), money: formatUsd(row.money) })}
              {row.rate !== null && <span className="work-tokens-rate">{t("workTokens.rate", { price: formatPrice(row.rate) })}</span>}
            </dd>
          </Fragment>
        ))}
        {/* The time and the money of the run, with their limits (asked for: here, not in the top bar). */}
        <dt>{t("workTokens.time")}</dt>
        <dd className="mono">{t("workTokens.ofLimit", { used: hoursAndMinutes(work.workedMs, t), limit: t("projectWork.hoursShort", { h: work.hours }) })}</dd>
        <dt>{t("workTokens.spent")}</dt>
        <dd className="mono">{t("workTokens.ofLimit", { used: formatUsd(work.spentUsd), limit: formatUsd(work.budgetUsd) })}</dd>
      </dl>
      {/* The note explains the bar: none without the model's window (seen: it spoke of a bar that was not there). */}
      {size && <p className="muted work-tokens-note">{t("workTokens.note")}</p>}
      {onFresh && work.status !== "running" && (
        <div className="work-tokens-fresh">
          {/* Said in a video on agents: a request late in a long conversation costs several times one at its start. */}
          {context !== null && (size ? context / size >= LONG_SHARE : context >= LONG_TOKENS) && <p className="work-tokens-long">{t("workTokens.long")}</p>}
          <button className="btn is-small" onClick={onFresh}>
            {t("workTokens.fresh")}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The money of each kind of token: by the rates the model was billed at, fitted to the provider's own bill, so the three
 * add up to what was spent. The cache is apart from new reading (asked for: what the cache alone costs).
 */
export function moneyByKind(work: Pick<ProjectWorkView, "tokens" | "rates" | "spentUsd">): {
  key: string;
  label: MessageKey;
  tokens: number;
  money: number | null;
  rate: number | null;
}[] {
  const { input, cached, output } = work.tokens;
  const fresh = Math.max(0, input - cached);
  const r = work.rates;
  const raw = r ? [(fresh * r.input) / 1e6, (cached * r.cached) / 1e6, (output * r.output) / 1e6] : null;
  const sum = raw ? raw[0]! + raw[1]! + raw[2]! : 0;
  const fit = raw && sum > 0 && work.spentUsd > 0 ? work.spentUsd / sum : 1;
  const money = (i: number) => (raw ? raw[i]! * fit : null);
  return [
    { key: "fresh", label: "workTokens.readNew", tokens: fresh, money: money(0), rate: r?.input ?? null },
    { key: "cached", label: "workTokens.readCached", tokens: cached, money: money(1), rate: r?.cached ?? null },
    { key: "out", label: "workTokens.write", tokens: output, money: money(2), rate: r?.output ?? null },
  ];
}
