import type { Locale } from "@artel/shared";
import { translate } from "../i18n";

interface Props {
  locale: Locale;
  reason: "noToken" | "failed";
  detail?: string;
}

/** Shown before the app context exists, so it translates directly. */
export function BootError({ locale, reason, detail }: Props) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  return (
    <main className="desk is-alone">
      <article className="sheet">
        <div className="sheet-body">
          <h1>{t("boot.failedTitle")}</h1>
          <p className="lede">{reason === "noToken" ? t("boot.noToken") : t("boot.failedBody")}</p>
          {detail && <pre className="mono error-detail">{detail}</pre>}
        </div>
      </article>
    </main>
  );
}
