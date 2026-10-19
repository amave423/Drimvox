import { installCommand, presetIds, presets, type PresetId } from "@artel/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { ErrorNote } from "../ErrorNote";
import { presetName } from "./presetName";

interface Problem {
  code: string;
  detail?: string;
}

/** "key": services reached by an API key or locally; "subscription": programs that run on the user's own subscription. */
export function ConnectForm({ kind }: { kind: "key" | "subscription" }) {
  const { api, t, status, reloadProviders } = useApp();
  const [preset, setPreset] = useState<PresetId | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  function choose(id: PresetId) {
    setPreset(id);
    setName("");
    setBaseUrl(presets[id].baseUrl);
    setApiKey("");
    setProblem(null);
  }

  async function submit() {
    if (!preset) return;
    const p = presets[preset];
    setBusy(true);
    setProblem(null);
    const res = await api.providers
      .$post({
        json: {
          preset,
          name: name.trim() || undefined,
          baseUrl: p.editableUrl ? baseUrl.trim() || undefined : undefined,
          apiKey: apiKey.trim() || undefined,
        },
      })
      .catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setPreset(null);
      await reloadProviders();
      return;
    }
    const body = (await res?.json().catch(() => null)) as {
      error?: Problem;
    } | null;
    setProblem(body?.error?.code === "invalid" ? body.error : { code: res ? "invalid" : "unknown" });
  }

  const p = preset ? presets[preset] : null;
  const keyMissing = p?.keyRequired && !apiKey.trim();
  const urlMissing = p?.editableUrl && !baseUrl.trim();

  return (
    <div className="connect">
      <div className="preset-grid" role="radiogroup" aria-label={t(kind === "key" ? "providers.add" : "providers.subscriptions")}>
        {presetIds
          // Gemini CLI no longer serves personal Google accounts (Google, 2026-06-18): Antigravity CLI replaces it.
          .filter((id) => id !== "gemini-cli" && (presets[id].billing === "subscription") === (kind === "subscription"))
          .map((id) => (
            <button key={id} role="radio" aria-checked={preset === id} className={`preset${preset === id ? " is-on" : ""}`} onClick={() => choose(id)}>
              <span className="preset-name">{presetName(t, id)}</span>
              <span className="preset-hint">{t(`providers.hint.${id}` as MessageKey)}</span>
            </button>
          ))}
      </div>

      {p && preset && (
        <form
          className="connect-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!keyMissing && !urlMissing) void submit();
          }}
        >
          <label className="field">
            <span>{t("providers.field.name")}</span>
            <input className="field-input" value={name} placeholder={presetName(t, preset)} onChange={(e) => setName(e.target.value)} />
          </label>
          {p.editableUrl && (
            <label className="field">
              <span>{t("providers.field.baseUrl")}</span>
              <input className="field-input mono" value={baseUrl} placeholder="https://example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
          )}
          {p.cli ? (
            <div className="cli-note">
              <p>{t("providers.cli.needs", { command: p.cli.command })}</p>
              <code className="mono cli-install">{installCommand(preset, status.platform)}</code>
              <p>{t("providers.cli.login", { command: p.cli.command })}</p>
              {preset === "gemini-cli" && <p className="is-pencil-text">{t("providers.cli.geminiRetired")}</p>}
            </div>
          ) : (
            <label className="field">
              <span>
                {p.keyRequired ? t("providers.field.apiKey") : t("providers.field.apiKeyOptional")}
                {p.keyUrl && (
                  <>
                    {" "}
                    <a href={p.keyUrl} target="_blank" rel="noreferrer">
                      {t("providers.getKey")}
                    </a>
                  </>
                )}
              </span>
              <input className="field-input mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </label>
          )}
          {problem && <ErrorNote error={problem} />}
          <div className="actions">
            <button className="btn is-primary" disabled={busy || !!keyMissing || !!urlMissing}>
              {busy ? t("providers.checking") : t("providers.connect")}
            </button>
            <button type="button" className="btn" onClick={() => setPreset(null)}>
              {t("providers.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
