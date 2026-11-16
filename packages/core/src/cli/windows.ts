/**
 * Seen live: Codex on Windows changed files with Windows PowerShell 5.1 (`Get-Content -Raw`, `.Replace`, `Set-Content`),
 * which reads UTF-8 without a BOM as the local code page and writes it back so: every Russian word of the interface
 * became "РќР°РїСЂРёРјРµСЂ", and the run still ended with "all checked". Drimvox's own agents use Git Bash; a CLI
 * agent uses whatever shell it likes, so it is told.
 */
export const WINDOWS_FILES_HINT = [
  "This computer runs Windows, and its PowerShell 5.1 reads and writes files in the local code page, not UTF-8: text in",
  "Russian or any other non-Latin script comes out broken. Never change files through PowerShell (Get-Content, Set-Content,",
  "Out-File, > redirects, .Replace on file text). Change files with your own editing tool, or with node using 'utf8'",
  "explicitly. After changing a file that holds such text, read a line of it back and make sure the words are intact.",
].join(" ");

/** The rules a CLI agent works by in a project, with what this computer needs on top. */
export function cliRules(rules: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${rules}\n\n${WINDOWS_FILES_HINT}` : rules;
}
