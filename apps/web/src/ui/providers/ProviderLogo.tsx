import type { PresetId } from "@drimvox/shared";
import { useBrandFill } from "../BrandFill";
import { siAnthropic, siClaude, siDeepseek, siGoogle, siGooglegemini, siHuggingface, siKimi, siLmstudio, siMinimax, siMistralai, siNvidia, siOllama, siOpencode, siOpenrouter, siQwen, siX } from "simple-icons";

/** A provider's mark, in the app's violet-to-blue as the catalog's (seen: the providers had none, the MCP servers had theirs). */
const marks: Partial<Record<PresetId, string>> = {
  openrouter: siOpenrouter.path,
  anthropic: siAnthropic.path,
  "claude-code": siClaude.path,
  google: siGooglegemini.path,
  antigravity: siGoogle.path,
  xai: siX.path,
  deepseek: siDeepseek.path,
  nvidia: siNvidia.path,
  ollama: siOllama.path,
  lmstudio: siLmstudio.path,
  mistral: siMistralai.path,
  moonshot: siKimi.path,
  qwen: siQwen.path,
  minimax: siMinimax.path,
  huggingface: siHuggingface.path,
  opencode: siOpencode.path,
};

/** The mark on a tile; a provider without one (OpenAI's is not in the free icon set, a custom server) shows its initial. */
export function ProviderLogo({ preset, name, size = 32 }: { preset: PresetId; name: string; size?: number }) {
  const path = marks[preset];
  const brand = useBrandFill();
  return (
    <span className="catalog-logo provider-logo" style={{ width: size, height: size }} aria-hidden>
      {path ? (
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55}>
          {brand.defs}
          <path d={path} fill={brand.fill} />
        </svg>
      ) : (
        <span className="provider-initial">{name.trim().charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}
