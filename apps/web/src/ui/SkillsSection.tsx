import type { SkillView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { ok } from "../api";
import { Hint } from "./Hint";
import { useApp } from "../context";

/** Shared skills: instructions any agent can open when they fit its task. */
export function SkillsSection() {
  const { api, t } = useApp();
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    setSkills(await api.skills.$get().then((r) => ok<SkillView[]>(r)).catch(() => []));
  }
  useEffect(() => {
    void load();
  }, []);

  const failed = async (res: Response | null) => {
    const code = ((await res?.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
    setProblem(code === "exists" ? t("skills.exists") : code === "not_skill" ? t("skills.notSkill") : t("skills.failed"));
  };

  async function create() {
    setProblem(null);
    const res = await api.skills.$post({ json: { name, description, instructions } }).catch(() => null);
    if (!res?.ok) return failed(res as Response | null);
    setCreating(false);
    setName("");
    setDescription("");
    setInstructions("");
    await load();
  }

  async function importFolder() {
    setProblem(null);
    const folder = await window.drimvox?.pickFolder?.();
    if (!folder) return;
    const res = await api.skills.import.$post({ json: { path: folder } }).catch(() => null);
    if (!res?.ok) return failed(res as Response | null);
    await load();
  }

  async function remove(skill: string) {
    await api.skills[":name"].$delete({ param: { name: skill } }).catch(() => null);
    setRemoving(null);
    await load();
  }

  return (
    <section className="skills">
      <h2 className="sheet-h">
        {t("skills.title")}
        <Hint text={t("skills.lede")} />
      </h2>
      {skills.length === 0 ? (
        <p className="muted">{t("skills.empty")}</p>
      ) : (
        <ul className="skill-list">
          {skills.map((s) => (
            <li key={s.name}>
              <strong className="mono">{s.name}</strong>
              <span>{s.description}</span>
              {removing === s.name ? (
                <button className="link is-pencil" onClick={() => void remove(s.name)}>
                  {t("skills.removeConfirm")}
                </button>
              ) : (
                <button className="link is-pencil" onClick={() => setRemoving(s.name)}>
                  {t("skills.remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <form
          className="skill-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="field">
            <span>{t("skills.name")}</span>
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("skills.description")}</span>
            <input className="field-input" value={description} placeholder={t("skills.descriptionHint")} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("skills.instructions")}</span>
            <textarea className="field-input mono" rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
          <div className="actions">
            <button className="btn is-primary" disabled={!name.trim() || !description.trim() || !instructions.trim()}>
              {t("skills.save")}
            </button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              {t("providers.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className="btn" onClick={() => setCreating(true)}>
            {t("skills.create")}
          </button>
          {window.drimvox?.pickFolder && (
            <button className="btn" onClick={() => void importFolder()}>
              {t("skills.import")}
            </button>
          )}
          {window.drimvox?.openSkillsFolder && (
            <button className="link" onClick={() => window.drimvox?.openSkillsFolder()}>
              {t("skills.openFolder")}
            </button>
          )}
        </div>
      )}
      {problem && <p className="error-note">{problem}</p>}
    </section>
  );
}

/** A project's own skills, from `.drimvox/skills` and `.claude/skills` in its folder. */
export function ProjectSkills({ projectId }: { projectId: string }) {
  const { api, t } = useApp();
  const [skills, setSkills] = useState<SkillView[]>([]);
  useEffect(() => {
    void api.projects[":id"].skills
      .$get({ param: { id: projectId } })
      .then((r) => ok<SkillView[]>(r))
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [api, projectId]);
  if (skills.length === 0) return null;
  return (
    <div className="note">
      <strong>{t("skills.projectTitle")}</strong>
      <ul className="skill-list is-compact">
        {skills.map((s) => (
          <li key={s.name} title={s.path}>
            <span className="mono">{s.name}</span>
            <span className="muted">{s.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
