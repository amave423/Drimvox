import type { SubscriptionLimit } from "@artel/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";

/**
 * What is left of a subscription's limit, as its program said on the last run: "5 hours: 12% used, starts over at
 * 14:00". Before the first run there is nothing to show but how Artel learns it. `seen` re-reads after an answer.
 */
export function SubscriptionLimits({ providerId, seen = 0 }: { providerId: string; seen?: number }) {
  const { api, t, settings } = useApp();
  const [limits, setLimits] = useState<SubscriptionLimit[] | null>(null);

  useEffect(() => {
    let live = true;
    void api.providers[":id"].limits
      .$get({ param: { id: providerId } })
      .then((r) => (r.ok ? (r.json() as Promise<SubscriptionLimit[]>) : []))
      .then((v) => live && setLimits(v))
      .catch(() => live && setLimits([]));
    return () => {
      live = false;
    };
  }, [api, providerId, seen]);

  if (!limits) return null;
  if (limits.length === 0) return <p className="muted limits-unknown">{t("limits.unknown")}</p>;
  const when = (ms: number) => {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(settings.locale === "ru" ? "ru-RU" : "en-GB", sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  return (
    <ul className="limits" aria-label={t("limits.title")}>
      {limits.map((l) => {
        const name = ["five_hour", "seven_day"].includes(l.window) ? t(`limits.window.${l.window}` as MessageKey) : l.window;
        const left = l.usedShare === null ? null : Math.max(0, Math.round((1 - l.usedShare) * 100));
        return (
          <li key={l.window} className={`limit is-${l.status}`}>
            <span className="limit-name">{name}</span>
            {left !== null && (
              <span className="limit-bar" aria-hidden>
                <span style={{ width: `${100 - left}%` }} />
              </span>
            )}
            <span>
              {left !== null ? t("limits.left", { n: left }) : t(l.status === "reached" ? "limits.reached" : "limits.ok")}
              {l.resetsAt !== null && ` · ${t("limits.resets", { at: when(l.resetsAt) })}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
