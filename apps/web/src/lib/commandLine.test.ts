import { describe, expect, it } from "vitest";
import { parsePairs, splitCommand } from "./commandLine";

describe("splitCommand", () => {
  it("splits a command line into the program and its arguments, keeping quoted parts whole", () => {
    expect(splitCommand('npx -y @modelcontextprotocol/server-filesystem "C:\\Users\\Артём\\Мои проекты"')).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\Артём\\Мои проекты"],
    });
    expect(splitCommand("  uvx   mcp-server-git  ")).toEqual({ command: "uvx", args: ["mcp-server-git"] });
    expect(splitCommand("")).toBeNull();
  });
});

describe("parsePairs", () => {
  it("reads KEY=VALUE and Name: value lines, skipping empty ones", () => {
    expect(parsePairs("GITHUB_TOKEN=ghp_123\n\nEMPTY=\nURL=https://x.y/?a=b", "=")).toEqual({ GITHUB_TOKEN: "ghp_123", EMPTY: "", URL: "https://x.y/?a=b" });
    expect(parsePairs("Authorization: Bearer abc", ":")).toEqual({ Authorization: "Bearer abc" });
  });
});
