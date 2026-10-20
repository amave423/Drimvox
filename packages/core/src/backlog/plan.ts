/**
 * A check is a command a runner understands, not a sentence (seen live: "Кнопка «Старт» запускает отсчёт" was run in
 * PowerShell, failed, and the coder spent half an hour making "the checks" pass).
 */
const RUNNER = /^(npm|npx|pnpm|yarn|bun|node|deno|tsc|vitest|jest|eslint|python3?|py|pytest|pip|uv|go|cargo|dotnet|make|mvn|gradle|gradlew|php|composer|ruby|bundle|rake|flutter|dart|swift)(\.exe|\.cmd)?(\s|$)|^\.{1,2}[\\/]/i;
export const isCommand = (check: string) => RUNNER.test(check.trim());

/**
 * What the coder of one task of the list is told (seen live: given "a working timer", it spent half an hour measuring the
 * look, which was a later task, in browsers it started itself).
 */
export function itemInstructions(checks: string[]): string {
  return [
    "This is one task of the project's list. The user checks the result, then picks the next one.",
    "- Do exactly this task: its 'done when' points. Do not do the work of other tasks of the list now.",
    "- Finish as soon as the points hold and the checks pass. Do not polish beyond the points: a reviewer and the user look next.",
    "- If there is an interface, start it and look at the page once or twice with look_at_page (also at width 390 for a phone).",
    "  Do not start browsers or measuring scripts yourself.",
    checks.length
      ? `- Checks (all must exit 0): ${checks.join(" ; ")}. Run them before you finish; Artel runs them again after.`
      : "- The project has no checks yet. If you set up tests or a build, name the commands in your summary.",
    "- Before you finish, keep the project's notes current with update_notes.",
  ].join("\n");
}
