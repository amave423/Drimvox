import { describe, expect, it } from "vitest";
import { dictionaries, guessLocale, translate } from "./i18n";
import { resolveTheme } from "./theme";

describe("dictionaries", () => {
  it("have the same keys in every language", () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.ru).sort());
  });

  it("have no empty strings", () => {
    for (const dict of Object.values(dictionaries)) {
      for (const [key, text] of Object.entries(dict)) expect(text.trim(), key).not.toBe("");
    }
  });

  it("use the same placeholders in every language", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(dictionaries.ru) as (keyof typeof dictionaries.ru)[]) {
      expect(vars(dictionaries.en[key]), key).toEqual(vars(dictionaries.ru[key]));
    }
  });
});

describe("translate", () => {
  // Seen: a task stopped for a reason with no text, and the whole window went white.
  it("never breaks on a key it does not know", () => {
    expect(translate("ru", "task.reason.no_such_reason" as never, { n: 1 })).toBe("task.reason.no_such_reason");
  });

  it("has a text for the reviewer giving no verdict", () => {
    expect(dictionaries.ru["task.reason.acceptance_error" as keyof typeof dictionaries.ru]).toBeTruthy();
  });

  it("fills placeholders", () => {
    expect(translate("en", "side.database", { version: 3 })).toBe("Database, schema 3");
  });

  it("leaves unknown placeholders visible", () => {
    expect(translate("en", "side.database")).toBe("Database, schema {version}");
  });
});

describe("guessLocale", () => {
  it("picks Russian for Russian systems and as a fallback", () => {
    expect(guessLocale(["ru-RU"])).toBe("ru");
    expect(guessLocale(["de-DE"])).toBe("ru");
    expect(guessLocale([])).toBe("ru");
  });

  it("picks English for English systems", () => {
    expect(guessLocale(["en-US", "ru"])).toBe("en");
  });
});

describe("resolveTheme", () => {
  it("follows the system only when asked to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
