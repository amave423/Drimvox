import { describe, expect, it } from "vitest";
import { holdsSecret } from "../src/agent/notes";

// Seen live: the laptop's sudo password went from the chat into AGENTS.md and from there to a public repository.
describe("secrets in the project's notes", () => {
  it("finds a password, key or token written out", () => {
    expect(holdsSecret("## Ноутбук (ml_server@192.168.1.129), sudo-пароль `hunter2x`")).toBe(true);
    expect(holdsSecret("`echo 'hunter2x' | sudo -S -p '' bash -lc '…'`")).toBe(true);
    expect(holdsSecret("API_KEY=sk-abcdef123456")).toBe(true);
    expect(holdsSecret("password: hunter2x")).toBe(true);
    expect(holdsSecret("токен «abcd1234efgh»")).toBe(false);
    expect(holdsSecret('token "abcd1234efgh"')).toBe(true);
  });

  it("leaves notes that only say where a secret is kept", () => {
    expect(holdsSecret("Пароль sudo знает пользователь; спросить его, когда понадобится.")).toBe(false);
    expect(holdsSecret("Tokens are kept in .env (not in git). Run npm test before a commit.")).toBe(false);
    expect(holdsSecret("Вход по паролю, сессии в cookie.")).toBe(false);
  });
});
