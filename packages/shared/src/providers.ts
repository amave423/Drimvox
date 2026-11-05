import { z } from "zod";

export const presetIds = [
  "openrouter",
  "routerai",
  "claude-code",
  "codex",
  "gemini-cli",
  "antigravity",
  "zai-coding",
  "kimi-coding",
  "qwen-coding",
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "nvidia",
  "groq",
  "cerebras",
  "mistral",
  "together",
  "fireworks",
  "zai",
  "moonshot",
  "qwen",
  "minimax",
  "huggingface",
  "sambanova",
  "opencode",
  "deepinfra",
  "novita",
  "chutes",
  "nebius",
  "hyperbolic",
  "cohere",
  "featherless",
  "nscale",
  "requesty",
  "aimlapi",
  "siliconflow",
  "inferencenet",
  "vercel",
  "baseten",
  "llama",
  "inception",
  "pollinations",
  "kilo",
  "cloudflare",
  "ollamacloud",
  "zhipu",
  "orcarouter",
  "teamorouter",
  "nararouter",
  "agnes",
  "gonka",
  "perplexity",
  "venice",
  "poe",
  "llm7",
  "byteplus",
  "hunyuan",
  "friendli",
  "nous",
  "arcee",
  "upstage",
  "writer",
  "parasail",
  "scaleway",
  "ovhcloud",
  "ollama",
  "lmstudio",
  "sdcpp",
  "whispercpp",
  "custom",
] as const;
export type PresetId = (typeof presetIds)[number];

export interface Preset {
  id: PresetId;
  name: string;
  baseUrl: string;
  /** Local servers run without a key. */
  keyRequired: boolean;
  /** Where to get a key; shown next to the key field. */
  keyUrl?: string;
  /** The user may change the address (local servers and custom endpoints). */
  editableUrl: boolean;
  /** How usage is billed: real money, provider credits, the user's subscription to a CLI, or nothing (local). */
  billing: "paid" | "credits" | "subscription" | "free";
  /** A command-line agent Drimvox runs instead of calling an API: its program and how to install it. */
  cli?: { command: string; install: string; /** When Windows installs it another way. */ installWindows?: string };
  /** What the provider's prices and costs are in. Drimvox converts rubles to dollars internally. */
  currency: "USD" | "RUB";
  /**
   * Free use (asked for: show who has free models, apart from those who have none): "all" — every model free up to a
   * limit; "some" — some of its models are free. Checked 2026-11 against the providers' own pages and catalogs.
   */
  free?: "all" | "some";
  /**
   * Its free use may train the provider's models on what is sent (said in a video on agents, and in the providers' own
   * terms): OpenRouter's free models (most of their hosts), NVIDIA's trial, Google AI Studio's free tier.
   */
  trainsOnFree?: true;
  /**
   * A coding subscription reached by its own key and address (GLM Coding Plan, Kimi Code, Alibaba Coding Plan): listed
   * with the subscriptions, paid by a flat fee, worked by Drimvox's own agent with all its tools (asked for: more
   * subscriptions than the CLIs).
   */
  plan?: true;
}

/** How much of a subscription's window is used, as its CLI reported it on the last run. */
export interface SubscriptionLimit {
  /** "five_hour", "seven_day", or another window the CLI names. */
  window: string;
  /** 0..1; null when the CLI only said whether it is allowed. */
  usedShare: number | null;
  /** When the window starts over, in milliseconds; null when not said. */
  resetsAt: number | null;
  status: "ok" | "warning" | "reached";
}

/** How to install a CLI on the computer the core runs on (`process.platform` there); null for presets without one. */
export function installCommand(id: PresetId, platform: string): string | null {
  const cli = presets[id].cli;
  if (!cli) return null;
  return platform === "win32" && cli.installWindows ? cli.installWindows : cli.install;
}

export const presets: Record<PresetId, Preset> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
    keyUrl: "https://openrouter.ai/settings/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "some",

    trainsOnFree: true,
  },
  routerai: {
    id: "routerai",
    name: "RouterAI",
    baseUrl: "https://routerai.ru/api/v1",
    keyRequired: true,
    keyUrl: "https://routerai.ru/",
    editableUrl: false,
    billing: "paid",
    currency: "RUB",
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    baseUrl: "",
    keyRequired: false,
    editableUrl: false,
    billing: "subscription",
    currency: "USD",
    cli: { command: "claude", install: "npm install -g @anthropic-ai/claude-code" },
  },
  codex: {
    id: "codex",
    name: "Codex",
    baseUrl: "",
    keyRequired: false,
    editableUrl: false,
    billing: "subscription",
    currency: "USD",
    cli: { command: "codex", install: "npm install -g @openai/codex" },
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    baseUrl: "",
    keyRequired: false,
    editableUrl: false,
    billing: "subscription",
    currency: "USD",
    cli: { command: "gemini", install: "npm install -g @google/gemini-cli" },
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity CLI",
    baseUrl: "",
    keyRequired: false,
    editableUrl: false,
    billing: "subscription",
    currency: "USD",
    // Google's own installers (antigravity.google/docs/getting-started, CLI tab).
    cli: { command: "agy", install: "curl -fsSL https://antigravity.google/cli/install.sh | bash", installWindows: "irm https://antigravity.google/cli/install.ps1 | iex" },
  },
  // The vendors' coding subscriptions take their own key on their own address, OpenAI-compatible (2026-11).
  "zai-coding": {
    id: "zai-coding",
    name: "GLM Coding Plan (Z Code)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    keyRequired: true,
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    plan: true,
  },
  "kimi-coding": {
    id: "kimi-coding",
    name: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding/v1",
    keyRequired: true,
    keyUrl: "https://www.kimi.com/code/console",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    plan: true,
  },
  "qwen-coding": {
    id: "qwen-coding",
    name: "Alibaba Coding Plan (Qwen)",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    keyRequired: true,
    keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=coding-plan",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    plan: true,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyRequired: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyRequired: true,
    keyUrl: "https://platform.openai.com/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  google: {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyRequired: true,
    keyUrl: "https://aistudio.google.com/apikey",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "some",

    trainsOnFree: true,
  },
  xai: {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyRequired: true,
    keyUrl: "https://console.x.ai/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyRequired: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyRequired: true,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    editableUrl: false,
    billing: "credits",
    currency: "USD",

    free: "all",

    trainsOnFree: true,
  },
  // Popular OpenAI-style providers, many with a free tier (asked for: more providers as cards).
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyRequired: true,
    keyUrl: "https://console.groq.com/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "all",
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyRequired: true,
    keyUrl: "https://cloud.cerebras.ai/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "all",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyRequired: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "all",
  },
  together: {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyRequired: true,
    keyUrl: "https://api.together.ai/settings/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyRequired: true,
    keyUrl: "https://fireworks.ai/account/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  zai: {
    id: "zai",
    name: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyRequired: true,
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  moonshot: {
    id: "moonshot",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/v1",
    keyRequired: true,
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  qwen: {
    id: "qwen",
    name: "Qwen (Alibaba)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyRequired: true,
    keyUrl: "https://modelstudio.console.alibabacloud.com/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    keyRequired: true,
    keyUrl: "https://platform.minimax.io/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  huggingface: {
    id: "huggingface",
    name: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    keyRequired: true,
    keyUrl: "https://huggingface.co/settings/tokens",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "some",
  },
  sambanova: {
    id: "sambanova",
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    keyRequired: true,
    keyUrl: "https://cloud.sambanova.ai/apis",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    keyRequired: true,
    keyUrl: "https://opencode.ai/auth",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "some",
  },
  deepinfra: {
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    keyRequired: true,
    keyUrl: "https://deepinfra.com/dash/api_keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  novita: {
    id: "novita",
    name: "Novita AI",
    baseUrl: "https://api.novita.ai/v3/openai",
    keyRequired: true,
    keyUrl: "https://novita.ai/settings/key-management",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  chutes: {
    id: "chutes",
    name: "Chutes",
    baseUrl: "https://llm.chutes.ai/v1",
    keyRequired: true,
    keyUrl: "https://chutes.ai/app/api",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  nebius: {
    id: "nebius",
    name: "Nebius AI",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    keyRequired: true,
    keyUrl: "https://tokenfactory.nebius.com/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  hyperbolic: {
    id: "hyperbolic",
    name: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    keyRequired: true,
    keyUrl: "https://app.hyperbolic.xyz/settings",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  cohere: {
    id: "cohere",
    name: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    keyRequired: true,
    keyUrl: "https://dashboard.cohere.com/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "all",
  },
  featherless: {
    id: "featherless",
    name: "Featherless",
    baseUrl: "https://api.featherless.ai/v1",
    keyRequired: true,
    keyUrl: "https://featherless.ai/account/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  nscale: {
    id: "nscale",
    name: "Nscale",
    baseUrl: "https://inference.api.nscale.com/v1",
    keyRequired: true,
    keyUrl: "https://console.nscale.com/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  requesty: {
    id: "requesty",
    name: "Requesty",
    baseUrl: "https://router.requesty.ai/v1",
    keyRequired: true,
    keyUrl: "https://app.requesty.ai/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  aimlapi: {
    id: "aimlapi",
    name: "AI/ML API",
    baseUrl: "https://api.aimlapi.com/v1",
    keyRequired: true,
    keyUrl: "https://aimlapi.com/app/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  siliconflow: {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.com/v1",
    keyRequired: true,
    keyUrl: "https://cloud.siliconflow.com/account/ak",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  inferencenet: {
    id: "inferencenet",
    name: "Inference.net",
    baseUrl: "https://api.inference.net/v1",
    keyRequired: true,
    keyUrl: "https://inference.net/dashboard/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  vercel: {
    id: "vercel",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    keyRequired: true,
    keyUrl: "https://vercel.com/dashboard/ai-gateway",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "some",
  },
  baseten: {
    id: "baseten",
    name: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    keyRequired: true,
    keyUrl: "https://app.baseten.co/settings/api_keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  llama: {
    id: "llama",
    name: "Llama API (Meta)",
    baseUrl: "https://api.llama.com/compat/v1",
    keyRequired: true,
    keyUrl: "https://llama.developer.meta.com/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  inception: {
    id: "inception",
    name: "Inception",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    keyRequired: true,
    keyUrl: "https://platform.inceptionlabs.ai/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  pollinations: {
    id: "pollinations",
    name: "Pollinations",
    baseUrl: "https://text.pollinations.ai/openai",
    keyRequired: false,
    keyUrl: "https://auth.pollinations.ai/",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "some",
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    keyRequired: true,
    keyUrl: "https://www.perplexity.ai/account/api/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  venice: {
    id: "venice",
    name: "Venice AI",
    baseUrl: "https://api.venice.ai/api/v1",
    keyRequired: true,
    keyUrl: "https://venice.ai/settings/api",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  poe: {
    id: "poe",
    name: "Poe",
    baseUrl: "https://api.poe.com/v1",
    keyRequired: true,
    keyUrl: "https://poe.com/api_key",
    editableUrl: false,
    billing: "credits",
    currency: "USD",
  },
  llm7: {
    id: "llm7",
    name: "LLM7",
    baseUrl: "https://api.llm7.io/v1",
    keyRequired: false,
    keyUrl: "https://token.llm7.io",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "some",
  },
  byteplus: {
    id: "byteplus",
    name: "BytePlus ModelArk",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
    keyRequired: true,
    keyUrl: "https://console.byteplus.com/ark",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  hunyuan: {
    id: "hunyuan",
    name: "Tencent Hunyuan",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    keyRequired: true,
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  friendli: {
    id: "friendli",
    name: "Friendli",
    baseUrl: "https://api.friendli.ai/serverless/v1",
    keyRequired: true,
    keyUrl: "https://friendli.ai/suite",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  nous: {
    id: "nous",
    name: "Nous Research",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    keyRequired: true,
    keyUrl: "https://portal.nousresearch.com",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  arcee: {
    id: "arcee",
    name: "Arcee AI",
    baseUrl: "https://api.arcee.ai/api/v1",
    keyRequired: true,
    keyUrl: "https://models.arcee.ai",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  upstage: {
    id: "upstage",
    name: "Upstage",
    baseUrl: "https://api.upstage.ai/v1",
    keyRequired: true,
    keyUrl: "https://console.upstage.ai/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  writer: {
    id: "writer",
    name: "Writer",
    baseUrl: "https://api.writer.com/v1",
    keyRequired: true,
    keyUrl: "https://app.writer.com",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  parasail: {
    id: "parasail",
    name: "Parasail",
    baseUrl: "https://api.parasail.io/v1",
    keyRequired: true,
    keyUrl: "https://www.saas.parasail.io",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  scaleway: {
    id: "scaleway",
    name: "Scaleway",
    baseUrl: "https://api.scaleway.ai/v1",
    keyRequired: true,
    keyUrl: "https://console.scaleway.com/iam/api-keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
  },
  ovhcloud: {
    id: "ovhcloud",
    name: "OVHcloud AI Endpoints",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyRequired: false,
    keyUrl: "https://endpoints.ai.cloud.ovh.net",
    editableUrl: false,
    billing: "paid",
    currency: "USD",

    free: "all",
  },
  kilo: {
    id: "kilo",
    name: "Kilo Code Gateway",
    baseUrl: "https://api.kilo.ai/api/gateway",
    keyRequired: false,
    keyUrl: "https://app.kilo.ai",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "some",
  },
  cloudflare: {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    // The account's id goes into the address; the form shows it to fill in.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
    keyRequired: true,
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    editableUrl: true,
    billing: "paid",
    currency: "USD",
    free: "all",
  },
  ollamacloud: {
    id: "ollamacloud",
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    keyRequired: true,
    keyUrl: "https://ollama.com/settings/keys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "all",
  },
  zhipu: {
    id: "zhipu",
    name: "Zhipu AI (BigModel)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyRequired: true,
    keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "some",
  },
  orcarouter: {
    id: "orcarouter",
    name: "OrcaRouter",
    baseUrl: "https://api.orcarouter.ai/v1",
    keyRequired: true,
    keyUrl: "https://www.orcarouter.ai",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "some",
  },
  teamorouter: {
    id: "teamorouter",
    name: "TeamoRouter",
    baseUrl: "https://api.teamorouter.com/v1",
    keyRequired: true,
    keyUrl: "https://teamorouter.com",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "some",
  },
  nararouter: {
    id: "nararouter",
    name: "NaraRouter",
    baseUrl: "https://router.bynara.id/v1",
    keyRequired: true,
    keyUrl: "https://router.bynara.id",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "some",
  },
  agnes: {
    id: "agnes",
    name: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    keyRequired: true,
    keyUrl: "https://apihub.agnes-ai.com",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "some",
  },
  gonka: {
    id: "gonka",
    name: "Gonka Broker",
    baseUrl: "https://proxy.gonkabroker.com/v1",
    keyRequired: true,
    keyUrl: "https://gonkabroker.com",
    editableUrl: false,
    billing: "paid",
    currency: "USD",
    free: "all",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyRequired: false,
    editableUrl: true,
    billing: "free",
    currency: "USD",
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyRequired: false,
    editableUrl: true,
    billing: "free",
    currency: "USD",
  },
  // Pictures on this computer (docs/specs/local-images.md): Drimvox makes this provider itself and runs the engine
  // in-process; the address is only a name.
  sdcpp: {
    id: "sdcpp",
    name: "stable-diffusion.cpp",
    baseUrl: "drimvox://sdcpp",
    keyRequired: false,
    editableUrl: false,
    billing: "free",
    currency: "USD",
  },
  // Speech on this computer (docs/specs/local-audio.md): made by Drimvox when a speech model is downloaded.
  whispercpp: {
    id: "whispercpp",
    name: "whisper.cpp",
    baseUrl: "drimvox://whisper",
    keyRequired: false,
    editableUrl: false,
    billing: "free",
    currency: "USD",
  },
  custom: {
    id: "custom",
    name: "OpenAI-совместимый",
    baseUrl: "",
    keyRequired: false,
    editableUrl: true,
    billing: "paid",
    currency: "USD",
  },
};

const baseUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "http or https only")
  .transform((u) => u.replace(/\/+$/, ""));

export const providerCreateSchema = z
  .object({
    preset: z.enum(presetIds),
    name: z.string().trim().min(1).max(60).optional(),
    baseUrl: baseUrlSchema.optional(),
    apiKey: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const providerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    baseUrl: baseUrlSchema.optional(),
    apiKey: z.string().trim().min(1).max(500).optional(),
    /** Send this provider's requests through the proxy from the settings. */
    useProxy: z.boolean().optional(),
    /** Paid by a flat fee, not by tokens (a custom server's subscription): its models count as free. */
    flat: z.boolean().optional(),
  })
  .strict();

export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

/** What the API returns about a provider. The key itself never leaves the core. */
export interface ProviderView {
  id: string;
  preset: PresetId;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  billing: Preset["billing"];
  currency: Preset["currency"];
  /** Requests go through the proxy from the settings. */
  useProxy: boolean;
  flat: boolean;
  createdAt: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per 1M tokens; null when the provider does not publish prices. */
  priceIn: number | null;
  priceOut: number | null;
  /** USD per 1M input tokens the provider serves from its cache, when it publishes such a price. */
  priceCacheRead?: number;
  /** True when prices come from a table built into Drimvox rather than from the provider. */
  priceEstimated: boolean;
  tools: boolean | null;
  /** Understands pictures in the prompt; null when the catalog does not say. */
  vision: boolean | null;
  /** Takes sound: such a model can write dictation down (the catalog says so; absent when it does not). */
  audio?: boolean;
  /** For a CLI's "default": the model it actually ran last time, when Drimvox has seen one. */
  resolved?: string | null;
  /** Whether a free model answers, when Drimvox has asked it or chatted with it lately. */
  available?: Availability;
  /** A key without billing may use it free up to a daily limit (Google); the prices are those past it. */
  freeTier?: boolean;
}

/** A model answers, is busy right now (a queue, a limit), or is gone (no longer served, or closed to the key). */
export type Availability = "ok" | "busy" | "gone";

/** Problems talking to a provider, as codes the UI translates. */
export const providerErrorCodes = [
  "account_region",
  "bad_key",
  "no_funds",
  "rate_limited",
  "model_not_found",
  "provider_error",
  /** The provider answered, but not in a form that could be read (often: tools through a reseller). */
  "bad_response",
  "unreachable",
  "timeout",
  "no_key",
  /** A command-line agent is not installed. */
  "cli_missing",
  /** A command-line agent is installed but not logged in to its account. */
  "cli_login",
  /** The CLI is too old for this model and asks to be updated. */
  "cli_update",
  /** The vendor no longer serves this CLI to the user's kind of account (Gemini CLI for personal Google accounts). */
  "cli_retired",
  /** The subscription's limit for this model is used up. */
  "cli_limit",
  /** The model has no free tier for this key (Google): it needs billing. */
  "no_free_tier",
  /** The provider should go through a proxy, but none is set in the settings. */
  "no_proxy",
  /** The answer stopped where the model ran out of room (its context or its answer limit). */
  "cut_off",
  "step_limit",
  /** The model only thought and gave no answer. */
  "no_answer",
  /** The key works, but may not use this model. */
  "forbidden",
  /** The model is overloaded right now. */
  "overloaded",
  /** The model cannot call tools; Drimvox remembers and sends it none (seen with Groq's allam). */
  "no_tools",
  /** The request is larger than the model's context or its free tier's tokens per minute (seen with Groq). */
  "too_large",
  /** The provider does not serve the user's country. */
  "region",
  "unknown",
] as const;
export type ProviderErrorCode = (typeof providerErrorCodes)[number];

export interface ProviderError {
  code: ProviderErrorCode;
  /** The provider's own wording, if any. Never contains the key. */
  detail?: string;
}

export interface Balance {
  amount: number;
  currency: string;
}
