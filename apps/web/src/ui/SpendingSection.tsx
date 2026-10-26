import type { ModelSpending } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../api";
import { useApp } from "../context";
import { formatUsd } from "../lib/format";

const DAYS = 30;

/**
 * Where the money went in the last month, by model, and cheaper models of the same maker with what the same answers
 * would have cost (asked for: "cheaper with the same quality"; the quality is the user's to judge).
 */
export function SpendingSection() {
  const { api, t } = useApp();
  const [rows, setRows] = useState<ModelSpending[] | null>(null);
  useEffect(() => {
    const since = String(Date.now() - DAYS * 24 * 3600_000);
    void api.usage.models
      .$get({ query: { since } })
      .then((r) => ok<ModelSpending[]>(r))
      .then(setRows)
      .catch(() => setRows([]));
  }, [api]);

  return (
    <section className="spending" aria-labelledby="spending-h">
      <h2 className="sheet-h" id="spending-h">
        {t("spending.title", { n: DAYS })}
      </h2>
      <p className="setting-about">{t("spending.hint")}</p>
      {rows === null ? null : rows.length === 0 ? (
        <p className="muted">{t("spending.empty")}</p>
      ) : (
        <ul className="spending-list">
          <li className="spending-total">
            <div className="spending-row">
              <span className="spending-model">{t("spending.total")}</span>
              <strong className="mono">{formatUsd(rows.reduce((sum, r) => sum + r.costUsd, 0))}</strong>
            </div>
          </li>
          {rows.map((r) => (
            <li key={`${r.providerId}/${r.model}`}>
              <div className="spending-row">
                <span className="mono spending-model" title={r.model}>
                  {r.providerName} / {r.model}
                </span>
                <span className="muted">{t("spending.answers", { n: r.answers })}</span>
                <strong className="mono">{formatUsd(r.costUsd)}</strong>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
