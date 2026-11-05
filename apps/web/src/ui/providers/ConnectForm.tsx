import { installCommand, presetIds, presets, type PresetId } from "@drimvox/shared";
import { useState } from "react";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";
import { ErrorNote } from "../ErrorNote";
import { presetName } from "./presetName";
import { ProviderLogo } from "./ProviderLogo";

interface Problem {
  code: string;
  detail?: string;
}

/**
 * The cards in groups (asked for: who has free models, apart from who has none): every model free up to a limit, some
 * models free, paid only. Subscriptions stay one group of their own.
 */
/** Paid by a subscription: a CLI on the user's account, or a coding plan reached by its own key. */
const subscribed = (id: PresetId) => presets[id].billing === "subscription" || !!presets[id].plan;

function groups(kind: "key" | "subscription"): { id: "all" | "some" | "paid" | "own" | "subscription"; ids: PresetId[] }[] {
  const shown = presetIds.filter(
    // Gemini CLI no longer serves personal Google accounts (Google, 2026-06-18): Antigravity CLI replaces it.
    // stable-diffusion.cpp is made by Drimvox itself when a picture model is downloaded.
    // Ollama is installed and run from "Local models".
    (id) => id !== "gemini-cli" && id !== "sdcpp" && id !== "whispercpp" && id !== "ollama" && subscribed(id) === (kind === "subscription"),
  );
  if (kind === "subscription") return [{ id: "subscription", ids: shown }];
  // A server of one's own (LM Studio on this computer, any address) is neither free nor paid by itself.
  const own = (id: PresetId) => id === "custom" || id === "lmstudio";
  return [
    ...(["all", "some", "paid"] as const).map((g) => ({ id: g, ids: shown.filter((id) => !own(id) && (presets[id].free ?? "paid") === g) })),
    { id: "own" as const, ids: shown.filter(own) },
  ];
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
      {groups(kind).map((g) => (
        <section key={g.id} className="preset-group" aria-labelledby={`preset-group-${g.id}`}>
          {g.id !== "subscription" && (
            <header className="preset-group-head">
              <h3 id={`preset-group-${g.id}`} className={`preset-group-title${g.id === "all" || g.id === "some" ? " is-free" : ""}`}>
                {t(`providers.group.${g.id}` as MessageKey)}
              </h3>
              <p className="muted">{t(`providers.group.${g.id}About` as MessageKey)}</p>
            </header>
          )}
          <div className="preset-grid" role="radiogroup" aria-label={g.id === "subscription" ? t("providers.subscriptions") : t(`providers.group.${g.id}` as MessageKey)}>
            {g.ids.map((id) => (
              <button key={id} role="radio" aria-checked={preset === id} className={`preset${preset === id ? " is-on" : ""}`} onClick={() => choose(id)}>
                <ProviderLogo preset={id} name={presetName(t, id)} size={30} />
                <span className="preset-text">
                  <span className="preset-name">{presetName(t, id)}</span>
                  <span className="preset-hint">{t(`providers.hint.${id}` as MessageKey)}</span>
                  {presets[id].free && <span className="preset-free">{t(`providers.free.${id}` as MessageKey)}</span>}
                  {presets[id].trainsOnFree && <span className="preset-trains">{t("providers.trainsOnFree")}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

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
          {preset === "cloudflare" && <p className="muted">{t("providers.cloudflareAccount")}</p>}
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
