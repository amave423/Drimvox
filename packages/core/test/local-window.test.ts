import { describe, expect, it } from "vitest";
import { autoWindow, kvBytesPerToken, windowFit } from "../src/local/window";

const GB = 2 ** 30;
// The user's computer: RTX 3080 with 10 GB, 32 GB of main memory.
const rtx3080 = { ramBytes: 32 * GB, gpu: { name: "NVIDIA GeForce RTX 3080", vramBytes: 10 * GB }, unified: false };

// What Ollama said of OmniCoder 9B (Qwen 3.5): attention in every fourth of 32 layers, 4 key-value heads of 256.
const omnicoder = {
  "general.architecture": "qwen35",
  "qwen35.block_count": 32,
  "qwen35.attention.head_count": 16,
  "qwen35.attention.head_count_kv": 4,
  "qwen35.attention.key_length": 256,
  "qwen35.attention.value_length": 256,
  "qwen35.embedding_length": 4096,
  "qwen35.full_attention_interval": 4,
};
// A plain model: Llama 3.1 8B, 32 layers, 8 key-value heads of 128.
const llama = { "general.architecture": "llama", "llama.block_count": 32, "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8, "llama.embedding_length": 4096 };

describe("the window of a local model", () => {
  it("counts the cache per token from what Ollama says of the model, attention layers only", () => {
    expect(kvBytesPerToken(omnicoder)).toBe(Math.round(8 * 4 * 512 * (34 / 32)));
    expect(kvBytesPerToken(llama)).toBe(Math.round(32 * 8 * 256 * (34 / 32)));
    expect(kvBytesPerToken({ "general.architecture": "x" })).toBeNull();
  });

  it("says where a window fits on the user's RTX 3080", () => {
    const per = kvBytesPerToken(omnicoder)!;
    const size = 6.9 * GB;
    expect(windowFit(size, per, 65_536, rtx3080)).toBe("fast");
    expect(windowFit(size, per, 131_072, rtx3080)).toBe("slow");
  });

  it("gives the largest window that keeps the largest model in the video card, or the old rule with none known", () => {
    expect(autoWindow(rtx3080, [{ sizeBytes: 6.9 * GB, perToken: kvBytesPerToken(omnicoder) }])).toBe(65_536);
    expect(autoWindow(rtx3080, [])).toBe(16_384);
    expect(autoWindow({ ...rtx3080, gpu: { name: "big", vramBytes: 24 * GB } }, [])).toBe(32_768);
  });
});
