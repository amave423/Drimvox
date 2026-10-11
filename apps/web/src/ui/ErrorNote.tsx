import { useApp } from "../context";
import { dictionaries, type MessageKey } from "../i18n";

/** A provider problem in the interface's words, with the provider's own wording underneath. */
export function ErrorNote({ error }: { error: { code: string; detail?: string } }) {
  const { t } = useApp();
  const key = `error.${error.code}`;
  const text = key in dictionaries.ru ? t(key as MessageKey) : t("error.unknown");
  return (
    <div className="error-note" role="alert">
      <p>{text}</p>
      {error.detail && <p className="mono error-note-detail">{error.detail}</p>}
    </div>
  );
}
