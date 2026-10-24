/** What the window remembered under the app's old name (Artel): the last model, the internet mode, the thinking level. */
const OLD = "artel.";
const NEW = "drimvox.";

/** Copies the old keys to the new names once; a key already set under the new name stays. */
export function moveLegacyStorage(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">): void {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(OLD)) old.push(key);
  }
  for (const key of old) {
    const next = NEW + key.slice(OLD.length);
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    storage.removeItem(key);
  }
}
