import { newChain, type ChainMember, type ChainView, type FreeCheck, type ModelChain } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { Dropdown } from "./Dropdown";
import { Toggle } from "./Toggle";

interface Free {
  providerId: string;
  model: string;
  name: string;
  providerName: string;
  tools: boolean | null;
  flat: boolean;
  check: FreeCheck;
}

/** A model's state in a word or two: resting after a limit, being asked, answering (how fast), busy, gone. */
function stateOf(m: { check: FreeCheck } & Partial<Pick<ChainMember, "state" | "until">>, t: (k: MessageKey, v?: Record<string, string | number>) => string): { text: string; tone: string } {
  if (m.state === "resting" && m.until) return { text: t("chains.resting", { time: new Date(m.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }), tone: "wait" };
  const c = m.check;
  if (c.state === "checking") return { text: t("chains.checking"), tone: "muted" };
  if (c.state === "ok") return { text: c.ms !== null ? t("chains.okMs", { s: (c.ms / 1000).toFixed(1).replace(".", ",") }) : t("chains.ok"), tone: "ok" };
  if (c.state === "busy") return { text: t("chains.busy"), tone: "wait" };
  if (c.state === "gone") return { text: t("chains.gone"), tone: "off" };
  return { text: t("chains.unknown"), tone: "muted" };
}

const plain = (c: ChainView): ModelChain => ({ id: c.id, name: c.name, models: c.models, order: c.order, onLimit: c.onLimit, onError: c.onError, timeoutS: c.timeoutS, toolsOnly: c.toolsOnly });

/**
 * Chains of free models (docs/specs/model-chains.md; asked for: variant A — the chains in a list, the chosen one beside
 * it): the models in turn, their state, and the rules of going on to the next. Drimvox's own chains are shown, not edited.
 */
export function ChainsSection() {
  const { api, t } = useApp();
  const [chains, setChains] = useState<ChainView[] | null>(null);
  const [free, setFree] = useState<Free[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const [polls, setPolls] = useState(0);

  const load = () => {
    void api.chains
      .$get()
      .then((r) => r.json())
      .then((list) => setChains(list as ChainView[]))
      .catch(() => setChains((c) => c ?? []));
    void api.chains.free
      .$get()
      .then((r) => r.json())
      .then((list) => setFree(list as Free[]))
      .catch(() => {});
  };
  useEffect(load, [api]);
  // While models are being asked, their states come in every two seconds (a minute at most).
  const asking = free.some((f) => f.check.state === "checking");
  useEffect(() => {
    if (!asking && polls === 0) return;
    if (polls > 30) return setPolls(0);
    const timer = setTimeout(() => {
      load();
      setPolls((n) => (asking ? n + 1 : 0));
    }, 2000);
    return () => clearTimeout(timer);
  }, [asking, polls]);
  async function checkNow() {
    await api.chains.check.$post().catch(() => null);
    setPolls(1);
  }

  if (!chains) return <p className="muted">{t("model.loading")}</p>;
  const current = chains.find((c) => c.id === chosen) ?? chains.find((c) => !c.auto) ?? chains[0];

  async function save(next: ModelChain[]) {
    const res = await api.chains.$put({ json: next }).catch(() => null);
    if (res?.ok) setChains((await res.json()) as ChainView[]);
  }
  const own = () => chains!.filter((c) => !c.auto).map(plain);
  const change = (patch: Partial<ModelChain>) => {
    if (!current || current.auto) return;
    void save(own().map((c) => (c.id === current.id ? { ...c, ...patch } : c)));
  };
  const create = () => {
    const id = `chain-${Date.now().toString(36)}`;
    setChosen(id);
    void save([...own(), newChain(id, t("chains.newName", { n: own().length + 1 }))]);
  };
  const move = (from: number, to: number) => {
    if (!current || to < 0 || to >= current.models.length || from === to) return;
    const models = [...current.models];
    const [m] = models.splice(from, 1);
    models.splice(to, 0, m!);
    change({ models });
  };
  // Those that answer first, the fastest first; those found not answering are not offered (seen: 40 of NVIDIA's 61).
  const rank = { ok: 0, unknown: 1, checking: 1, busy: 2, gone: 3 } as const;
  const offered = free
    .filter((f) => current && f.check.state !== "gone" && !current.models.some((m) => m.providerId === f.providerId && m.model === f.model) && (!current.toolsOnly || f.tools === true))
    .sort((a, b) => rank[a.check.state] - rank[b.check.state] || (a.check.ms ?? 1e9) - (b.check.ms ?? 1e9));

  return (
    <div className="chains">
      <div className="chains-top">
        <p className="setting-about">{t("chains.lede")}</p>
        <button type="button" className="btn" disabled={asking} onClick={() => void checkNow()}>
          {asking ? t("chains.checkingAll") : t("chains.checkNow")}
        </button>
      </div>
      <div className="chains-body">
        <nav className="chains-list" aria-label={t("chains.title")}>
          {chains.map((c) => (
            <button key={c.id} type="button" className={`chains-item${c.id === current?.id ? " is-on" : ""}`} aria-current={c.id === current?.id || undefined} onClick={() => setChosen(c.id)}>
              <strong>{c.name}</strong>
              <small className="muted">
                {c.auto ? t("chains.auto") : t("chains.count", { n: c.models.length })}
                {c.answered ? ` · ${t("chains.answered", { model: c.answered })}` : ""}
              </small>
            </button>
          ))}
          <button type="button" className="link chains-new" onClick={create}>
            {t("chains.new")}
          </button>
        </nav>
        {current && (
          <section className="chains-edit" aria-label={current.name}>
            {current.auto ? (
              <>
                <h3 className="setting-h">{current.name}</h3>
                <p className="muted">{t(current.toolsOnly ? "chains.autoCode" : "chains.autoChat")}</p>
              </>
            ) : (
              <div className="chains-head">
                <input className="field-input" aria-label={t("chains.name")} defaultValue={current.name} key={current.id} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== current.name && change({ name: e.target.value.trim() })} />
                <button type="button" className="btn is-pencil" onClick={() => void save(own().filter((c) => c.id !== current.id))}>
                  {t("chains.delete")}
                </button>
              </div>
            )}
            <ol className="chain-links">
              {current.members.map((m, i) => (
                <li
                  key={`${m.providerId}/${m.model}`}
                  className={`chain-link${dragged === i ? " is-dragged" : ""}`}
                  draggable={!current.auto}
                  onDragStart={() => setDragged(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragged !== null) move(dragged, i);
                    setDragged(null);
                  }}
                  onDragEnd={() => setDragged(null)}
                >
                  {!current.auto && (
                    <span className="chain-grip" aria-hidden>
                      ⋮⋮
                    </span>
                  )}
                  <span className="chain-num">{i + 1}</span>
                  <span className="chain-model">
                    {m.name}
                    <small className="muted">{m.providerName}</small>
                  </span>
                  <span className={`chain-state is-${stateOf(m, t).tone}`}>{stateOf(m, t).text}</span>
                  {!current.auto && (
                    <span className="chain-moves">
                      <button type="button" className="icon-button" aria-label={t("chains.up", { model: m.name })} disabled={i === 0} onClick={() => move(i, i - 1)}>
                        ↑
                      </button>
                      <button type="button" className="icon-button" aria-label={t("chains.down", { model: m.name })} disabled={i === current.members.length - 1} onClick={() => move(i, i + 1)}>
                        ↓
                      </button>
                      <button type="button" className="icon-button" aria-label={t("chains.remove", { model: m.name })} onClick={() => change({ models: current.models.filter((_, j) => j !== i) })}>
                        ×
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {current.members.length === 0 && <p className="muted">{t("chains.empty")}</p>}
            {!current.auto && (
              <Dropdown<string>
                label={t("chains.add")}
                value={null}
                placeholder={offered.length ? t("chains.add") : t("chains.noFree")}
                search={t("model.search")}
                options={offered.map((f, i) => ({ value: String(i), label: `${f.providerName} / ${f.name}`, hint: `${stateOf(f, t).text}${f.flat ? ` · ${t("chains.flat")}` : ""}` }))}
                onChange={(v) => {
                  const f = offered[Number(v)];
                  if (f) change({ models: [...current.models, { providerId: f.providerId, model: f.model }] });
                }}
              />
            )}
            {!current.auto && (
              <div className="chain-rules">
                <h3 className="setting-h">{t("chains.rules")}</h3>
                <div className="chain-order" role="radiogroup" aria-label={t("chains.order")}>
                  {(["list", "best"] as const).map((o) => (
                    <label key={o} className="radio-row">
                      <input type="radio" name={`order-${current.id}`} checked={current.order === o} onChange={() => change({ order: o })} />
                      {t(`chains.order.${o}`)}
                    </label>
                  ))}
                </div>
                <Toggle checked={current.onLimit} onChange={(onLimit) => change({ onLimit })}>
                  {t("chains.onLimit")}
                </Toggle>
                <Toggle checked={current.onError} onChange={(onError) => change({ onError })}>
                  {t("chains.onError")}
                </Toggle>
                <Toggle checked={current.timeoutS !== null} onChange={(on) => change({ timeoutS: on ? 20 : null })}>
                  {t("chains.onSilence", { s: current.timeoutS ?? 20 })}
                </Toggle>
                <Toggle checked={current.toolsOnly} onChange={(toolsOnly) => change({ toolsOnly })}>
                  {t("chains.toolsOnly")}
                </Toggle>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
