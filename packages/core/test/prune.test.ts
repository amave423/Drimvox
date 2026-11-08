import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { pruneOutputs } from "../src/agent/prune";

const read = (n: number, size: number): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `r${n}`, toolName: "read_file", input: { path: `f${n}.js` } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `r${n}`, toolName: "read_file", output: { type: "text", value: "a\n".repeat(size / 2) } }] },
];
const write = (n: number, size: number): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `w${n}`, toolName: "write_file", input: { path: `w${n}.js`, content: "b\n".repeat(size / 2) } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `w${n}`, toolName: "write_file", output: { type: "text", value: "Written." } }] },
];
const resultOf = (m: ModelMessage) => (m.content as any)[0].output.value as string;

// Seen live: every step of a weather site sent the model all it had read and written since the start, 61 thousand tokens
// a step on average, up to 112 thousand at the end.
describe("pruning old tool outputs", () => {
  it("keeps everything while the outputs fit the protected window", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Сделай сайт" }, ...read(1, 1000), ...write(2, 1000)];
    const { messages: sent, saved } = pruneOutputs(messages, 10_000, 5_000);
    expect(saved).toBe(0);
    expect(sent).toBe(messages);
  });

  it("replaces the oldest outputs and written files with a line, keeps the newest whole and the original untouched", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Сделай сайт" }, ...write(1, 6000), ...read(2, 6000), ...read(3, 6000), ...read(4, 6000)];
    const { messages: sent, saved } = pruneOutputs(messages, 10_000, 5_000);
    expect(saved).toBeGreaterThan(10_000);
    const call = (sent[1]!.content as any)[0];
    expect(call.input.path).toBe("w1.js");
    expect(call.input.content).toMatch(/3000 lines written/);
    expect(resultOf(sent[4]!)).toMatch(/old result of read_file f2\.js, 3000 lines/);
    // The newest two reads are inside the protected window.
    expect(resultOf(sent[6]!)).toHaveLength(6000);
    expect(resultOf(sent[8]!)).toHaveLength(6000);
    // The caller's messages are not changed: the next step prunes from them again.
    expect((messages[1]!.content as any)[0].input.content).toHaveLength(6000);
  });

  it("moves the line in chunks, so that the start of the request stays the same for many steps (the cache holds)", () => {
    const base: ModelMessage[] = [{ role: "user", content: "Сделай сайт" }, ...read(1, 4000), ...read(2, 4000), ...read(3, 4000), ...read(4, 4000)];
    const first = pruneOutputs(base, 8_000, 6_000).messages;
    const next = pruneOutputs([...base, ...read(5, 1000)], 8_000, 6_000).messages;
    expect(JSON.stringify(next.slice(0, first.length))).toBe(JSON.stringify(first));
  });

  it("never prunes a skill's instructions", () => {
    const skill: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "s", toolName: "use_skill", input: { name: "frontend-design" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "s", toolName: "use_skill", output: { type: "text", value: "z".repeat(20_000) } }] },
    ];
    const { messages: sent } = pruneOutputs([{ role: "user", content: "Сделай" }, ...skill, ...read(1, 20_000), ...read(2, 20_000)], 10_000, 5_000);
    expect(resultOf(sent[2]!)).toHaveLength(20_000);
    expect(resultOf(sent[4]!)).toMatch(/old result of read_file/);
  });
});
