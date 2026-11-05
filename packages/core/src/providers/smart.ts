/**
 * How capable a model is likely to be at code, from its id and name alone (free models come without benchmarks): the
 * strongest open families first, bigger ones before smaller, coding models before general ones, the small and fast
 * variants last. Asked for: "Auto: for code" put the fastest models first, and the fastest are the weakest.
 * Higher is smarter; only the order matters.
 */
const FAMILIES: [RegExp, number][] = [
  // Frontier and near-frontier, as free or flat-fee providers offer them.
  [/claude|opus|sonnet/, 100],
  [/gpt-?[5-9]|\bo[3-9]\b|gpt-?oss-?120/, 95],
  [/gemini-?[3-9].*pro|gemini-?2\.5-?pro/, 95],
  [/deepseek-?(v[3-9]|r[1-9])|deepseek-?chat|deepseek-?reasoner/, 92],
  [/kimi-?k[2-9]|kimi/, 91],
  [/glm-?[4-9]\.?[5-9]|glm-?[5-9]/, 90],
  [/qwen-?3.*coder|qwen3-?(max|235|480)|qwen-?max/, 90],
  [/minimax-?m[1-9]/, 88],
  [/grok-?[3-9]/, 88],
  [/devstral|codestral/, 84],
  [/gpt-?oss/, 82],
  [/qwen-?3|qwen3/, 80],
  [/gemini/, 80],
  [/llama-?4|maverick/, 78],
  [/mistral-?(large|medium)|magistral/, 76],
  [/nemotron.*(ultra|super)/, 76],
  [/llama-?3\.[1-3].*(405|70)/, 72],
  [/qwen-?2\.5.*coder/, 70],
  [/gemma-?[3-9]/, 62],
  [/phi-?[4-9]/, 58],
];

const SMALL = /\b(nano|mini|small|tiny|lite|light|micro|haiku|flash-?lite|instant)\b|[-_ ](1|1\.5|2|3|4|7|8|9)b\b/;
const FAST = /\b(flash|turbo|fast|air)\b/;
const CODE = /cod(er|ex|estral)|devstral|program/;

export function smartness(id: string, name = ""): number {
  const text = `${id} ${name}`.toLowerCase();
  let score = FAMILIES.find(([re]) => re.test(text))?.[1] ?? 50;
  // Billions of parameters, where named: a bigger model of a family knows more.
  const size = [...text.matchAll(/(\d{1,4}(?:\.\d)?)b\b/g)].map((m) => Number(m[1])).sort((a, b) => b - a)[0];
  if (size) score += Math.min(10, Math.log2(size));
  if (CODE.test(text)) score += 4;
  if (/thinking|reason|\br1\b/.test(text)) score += 2;
  if (SMALL.test(text)) score -= 25;
  else if (FAST.test(text)) score -= 8;
  return score;
}
