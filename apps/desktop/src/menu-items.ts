/**
 * What the right-click menu offers (no Electron here, so it can be tested): for a misspelled word, its corrections and
 * "Add to dictionary"; in a text field, cut, copy, paste and select all; over selected text, copy.
 */
export interface MenuParams {
  misspelledWord: string;
  dictionarySuggestions: string[];
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export type MenuItem =
  | { kind: "replace"; label: string; word: string }
  | { kind: "learn"; label: string; word: string }
  | { kind: "none"; label: string }
  | { kind: "role"; label: string; role: "cut" | "copy" | "paste" | "selectAll"; enabled: boolean }
  | { kind: "separator" };

const LABELS = {
  ru: { none: "Нет вариантов", learn: "Добавить в словарь", cut: "Вырезать", copy: "Копировать", paste: "Вставить", selectAll: "Выделить всё" },
  en: { none: "No suggestions", learn: "Add to dictionary", cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select all" },
};

/** Corrections shown at most: the first ones are the likeliest. */
const MAX_SUGGESTIONS = 6;

export function menuItems(p: MenuParams, locale: string): MenuItem[] {
  const l = locale.toLowerCase().startsWith("ru") ? LABELS.ru : LABELS.en;
  const items: MenuItem[] = [];
  if (p.misspelledWord) {
    const suggestions = p.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if (suggestions.length === 0) items.push({ kind: "none", label: l.none });
    for (const word of suggestions) items.push({ kind: "replace", label: word, word });
    items.push({ kind: "learn", label: l.learn, word: p.misspelledWord }, { kind: "separator" });
  }
  if (p.isEditable) {
    items.push(
      { kind: "role", label: l.cut, role: "cut", enabled: p.editFlags.canCut },
      { kind: "role", label: l.copy, role: "copy", enabled: p.editFlags.canCopy },
      { kind: "role", label: l.paste, role: "paste", enabled: p.editFlags.canPaste },
      { kind: "separator" },
      { kind: "role", label: l.selectAll, role: "selectAll", enabled: p.editFlags.canSelectAll },
    );
  } else if (p.selectionText.trim()) {
    items.push({ kind: "role", label: l.copy, role: "copy", enabled: true });
  }
  while (items.at(-1)?.kind === "separator") items.pop();
  return items;
}
