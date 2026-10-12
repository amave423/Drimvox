/** "npx -y pkg "C:\My folder"" → the program and its arguments; double quotes keep spaces in one argument. */
export function splitCommand(line: string): { command: string; args: string[] } | null {
  const parts = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  if (parts.length === 0) return null;
  return { command: parts[0]!, args: parts.slice(1) };
}

/** Lines of KEY=VALUE (environment) or Name: value (headers); the first separator splits. */
export function parsePairs(text: string, separator: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
}
