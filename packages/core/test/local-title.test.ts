import { localModelTitle } from "@drimvox/shared";
import { describe, expect, it } from "vitest";

// Asked for: models downloaded from Hugging Face showed as bare links in the lists.
describe("a local model's title", () => {
  it("names a Hugging Face model by its repository and quantisation, the maker apart", () => {
    expect(localModelTitle("hf.co/DavidAU/Qwen3.5-9B-The-Defiant-Fable-GGUF:Q4_K_M")).toEqual({ title: "Qwen3.5-9B-The-Defiant-Fable · Q4_K_M", owner: "DavidAU" });
    expect(localModelTitle("hf.co/unsloth/gemma-4-12b-it-GGUF")).toEqual({ title: "gemma-4-12b-it", owner: "unsloth" });
    expect(localModelTitle("qwen3:1.7b")).toEqual({ title: "qwen3:1.7b", owner: null });
  });
});
