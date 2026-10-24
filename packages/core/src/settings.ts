import { defaultSettings, settingsSchema, type Settings, type SettingsPatch } from "@drimvox/shared";
import type { Database } from "./db";

const shape = settingsSchema.shape;

/** Unknown or no-longer-valid stored values fall back to defaults key by key. */
export function readSettings(db: Database): Settings {
  const rows = db.sql.prepare("select key, value from settings").all() as { key: string; value: string }[];
  const result: Record<string, unknown> = { ...defaultSettings };
  for (const { key, value } of rows) {
    if (!(key in shape)) continue;
    const parsed = shape[key as keyof typeof shape].safeParse(JSON.parse(value));
    if (parsed.success) result[key] = parsed.data;
  }
  return result as Settings;
}

export function writeSettings(db: Database, patch: SettingsPatch): Settings {
  const upsert = db.sql.prepare(
    "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
  );
  db.sql.exec("begin");
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) upsert.run(key, JSON.stringify(value));
    }
    db.sql.exec("commit");
  } catch (err) {
    db.sql.exec("rollback");
    throw err;
  }
  return readSettings(db);
}
