import { describe, expect, it } from "vitest";
import { menuItems, type MenuParams } from "../src/menu-items";

const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const base: MenuParams = { misspelledWord: "", dictionarySuggestions: [], isEditable: false, selectionText: "", editFlags: flags };

describe("the right-click menu", () => {
  it("offers corrections for a misspelled word, then the editing commands", () => {
    const items = menuItems({ ...base, isEditable: true, misspelledWord: "превет", dictionarySuggestions: ["привет", "проверь"] }, "ru-RU");
    expect(items.map((i) => (i.kind === "separator" ? "—" : i.label))).toEqual([
      "привет",
      "проверь",
      "Добавить в словарь",
      "—",
      "Вырезать",
      "Копировать",
      "Вставить",
      "—",
      "Выделить всё",
    ]);
    expect(items[0]).toEqual({ kind: "replace", label: "привет", word: "привет" });
  });

  it("says so when there is nothing to suggest", () => {
    const items = menuItems({ ...base, isEditable: true, misspelledWord: "ыыыы" }, "ru");
    expect(items[0]).toEqual({ kind: "none", label: "Нет вариантов" });
  });

  it("offers only Copy over selected text outside a field, and nothing over plain page", () => {
    expect(menuItems({ ...base, selectionText: "текст" }, "en-US").map((i) => i.kind === "role" && i.role)).toEqual(["copy"]);
    expect(menuItems(base, "ru")).toEqual([]);
  });
});
