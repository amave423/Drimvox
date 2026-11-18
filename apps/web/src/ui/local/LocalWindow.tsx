import { localModelTitle, localWindowChoices, type LocalWindowChoice, type LocalWindowView } from "@drimvox/shared";
import { useCallback, useEffect, useState } from "react";
import { ok } from "../../api";
import { useApp } from "../../context";
import { Dropdown } from "../Dropdown";
import { useSize } from "./size";

const thousands = (tokens: number) => Math.round(tokens / 1024);

/**
 * The context window of the local models (asked for: "Ollama can put part of a model into main memory, make it
 * Drimvox's own"). The choice, and for each downloaded model where each window runs here: in the video card, partly in
 * main memory (slower), or nowhere. See docs/specs/local-models.md.
 */
export function LocalWindow({ models }: { models: number }) {
  const { api, t } = useApp();
  const size = useSize();
  const [view, setView] = useState<LocalWindowView | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const next = await api.local.window
      .$get()
      .then((r) => ok<LocalWindowView>(r))
      .catch(() => null);
    if (next) setView(next);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, models]);

  async function choose(value: string) {
    const choice = (value === "auto" ? "auto" : Number(value)) as LocalWindowChoice;
    setSaving(true);
    const next = await api.local.window
      .$put({ json: { choice } })
      .then((r) => ok<LocalWindowView>(r))
      .catch(() => null);
    setSaving(false);
    if (next) setView(next);
  }

  if (!view) return null;
  const label = (c: LocalWindowChoice) => (c === "auto" ? t("localWindow.auto", { n: thousands(view.auto) }) : t("localWindow.tokens", { n: thousands(c) }));
  const chosen = view.choice === "auto" ? view.auto : view.choice;
  return (
    <section className="local-window" aria-label={t("localWindow.title")}>
      <h2 className="sheet-h">{t("localWindow.title")}</h2>
      <div className="local-window-pick">
        <Dropdown
          value={String(view.choice)}
          label={t("localWindow.title")}
          disabled={saving}
          onChange={(v) => void choose(v)}
          options={localWindowChoices.map((c) => ({ value: String(c), label: label(c) }))}
        />
      </div>
      <p className="muted local-window-hint">{t("localWindow.hint")}</p>
      {view.userOllama && <p className="note">{t("localWindow.userOllama", { n: thousands(chosen) })}</p>}
      {view.models.length > 0 && (
        <ul className="local-window-models">
          {view.models.map((m) => {
            const option = m.options.find((o) => o.tokens === chosen) ?? m.options[0];
            return (
              <li key={m.name}>
                <span className="local-model-name">{localModelTitle(m.name).title}</span>
                {option?.bytes ? (
                  <span className={`local-window-fit is-${option.fit ?? "none"}`}>
                    {t(`localWindow.fit.${option.fit ?? "none"}`, { size: size(option.bytes) })}
                  </span>
                ) : (
                  <span className="muted">{t("localWindow.unknown")}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
