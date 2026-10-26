import type { McpServerView, McpStatus } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../api";
import { Hint } from "./Hint";
import { useApp } from "../context";
import { fromCatalog } from "../lib/catalog";
import { parsePairs, splitCommand } from "../lib/commandLine";
import { Toggle } from "./Toggle";

/** The user's MCP servers: tools for agents and chats, each new tool asking before its first call. */
export function McpSection() {
  const { api, t } = useApp();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [status, setStatus] = useState<Record<string, McpStatus | "loading">>({});
  const [adding, setAdding] = useState(false);

  async function load() {
    const list = await api.mcp.$get().then((r) => ok<McpServerView[]>(r)).catch(() => []);
    setServers(list.filter((s) => !fromCatalog(s)));
    for (const s of list.filter((x) => x.enabled)) void check(s.id);
  }
  async function check(id: string) {
    setStatus((m) => ({ ...m, [id]: "loading" }));
    const st = await api.mcp[":id"].status
      .$get({ param: { id } })
      .then((r) => ok<McpStatus>(r))
      .catch((): McpStatus => ({ ok: false, error: "—" }));
    setStatus((m) => ({ ...m, [id]: st }));
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(s: McpServerView) {
    await api.mcp[":id"].$patch({ param: { id: s.id }, json: { enabled: !s.enabled } }).catch(() => null);
    await load();
  }
  async function remove(s: McpServerView) {
    await api.mcp[":id"].$delete({ param: { id: s.id } }).catch(() => null);
    await load();
  }
  async function forget(s: McpServerView, tool: string) {
    await api.mcp[":id"].allowed[":tool"].$delete({ param: { id: s.id, tool } }).catch(() => null);
    await load();
  }

  return (
    <section className="mcp">
      <h2 className="sheet-h">
        {t("mcp.title")}
        <Hint text={t("mcp.lede")} />
      </h2>
      {servers.length === 0 && <p className="muted">{t("mcp.empty")}</p>}
      <ul className="mcp-list">
        {servers.map((s) => {
          const st = status[s.id];
          return (
            <li key={s.id} className={s.enabled ? undefined : "is-off"}>
              <div className="mcp-head">
                <strong>{s.name}</strong>
                <span className="mono muted mcp-target">{s.command ? [s.command, ...s.args].join(" ") : s.url}</span>
              </div>
              <div className="mcp-state">
                {!s.enabled ? (
                  <span className="muted">{t("mcp.off")}</span>
                ) : st === "loading" || !st ? (
                  <span className="muted">{t("mcp.connecting")}</span>
                ) : st.ok ? (
                  <span className="is-ok" title={st.tools.map((x) => x.name).join(", ")}>
                    {t("mcp.tools", { count: st.tools.length })}: {st.tools.map((x) => x.name).join(", ")}
                  </span>
                ) : (
                  <span className="is-pencil-text">{t("mcp.failed", { error: st.error })}</span>
                )}
              </div>
              {s.allowed.length > 0 && (
                <div className="mcp-allowed">
                  <span className="muted">{t("mcp.allowed")}</span>
                  {s.allowed.map((tool) => (
                    <button key={tool} className="chip" title={t("mcp.forget")} onClick={() => void forget(s, tool)}>
                      {tool} ×
                    </button>
                  ))}
                </div>
              )}
              <div className="actions">
                <Toggle checked={s.enabled} onChange={() => void toggle(s)}>
                  {t("mcp.enabled")}
                </Toggle>
                {s.enabled && (
                  <button className="link" onClick={() => void check(s.id)}>
                    {t("mcp.recheck")}
                  </button>
                )}
                <button className="link is-pencil" onClick={() => void remove(s)}>
                  {t("mcp.remove")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <McpForm
          onDone={async () => {
            setAdding(false);
            await load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button className="btn" onClick={() => setAdding(true)}>
          {t("mcp.add")}
        </button>
      )}
    </section>
  );
}

function McpForm({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const { api, t } = useApp();
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [failed, setFailed] = useState(false);

  const parsed = splitCommand(line);
  const ready = name.trim() && (kind === "stdio" ? !!parsed : /^https?:\/\//.test(url.trim()));

  async function save() {
    setFailed(false);
    const json =
      kind === "stdio"
        ? { name: name.trim(), command: parsed!.command, args: parsed!.args, env: parsePairs(env, "=") }
        : { name: name.trim(), url: url.trim(), headers: parsePairs(headers, ":") };
    const res = await api.mcp.$post({ json }).catch(() => null);
    if (!res?.ok) return setFailed(true);
    onDone();
  }

  return (
    <form
      className="mcp-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span>{t("mcp.name")}</span>
        <input className="field-input" value={name} placeholder="github" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="picker-kinds" role="tablist">
        {(["stdio", "http"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={k === kind} className={k === kind ? "is-on" : undefined} onClick={() => setKind(k)}>
            {t(`mcp.kind.${k}`)}
          </button>
        ))}
      </div>
      {kind === "stdio" ? (
        <>
          <label className="field">
            <span>{t("mcp.command")}</span>
            <input className="field-input mono" value={line} placeholder="npx -y @modelcontextprotocol/server-github" onChange={(e) => setLine(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("mcp.env")}</span>
            <textarea className="field-input mono" rows={3} value={env} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=..." onChange={(e) => setEnv(e.target.value)} />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>{t("mcp.url")}</span>
            <input className="field-input mono" value={url} placeholder="https://example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("mcp.headers")}</span>
            <textarea className="field-input mono" rows={2} value={headers} placeholder="Authorization: Bearer ..." onChange={(e) => setHeaders(e.target.value)} />
          </label>
        </>
      )}
      <p className="muted mcp-secret">{t("mcp.secretNote")}</p>
      <div className="actions">
        <button className="btn is-primary" disabled={!ready}>
          {t("mcp.save")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("providers.cancel")}
        </button>
      </div>
      {failed && <p className="error-note">{t("mcp.saveFailed")}</p>}
    </form>
  );
}
