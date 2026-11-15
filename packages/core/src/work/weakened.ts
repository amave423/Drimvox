/**
 * Tests that lost checks in a turn (seen in a video the user sent: a test showed 4032 characters instead of 4000, and the
 * agent removed the length check instead of fixing the code; the test went green, the task was not done). The tester is
 * shown which test files lost assertions, to check each was not weakened to pass.
 */

const TEST_FILE = /(^|\/)(tests?|e2e|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(_test\.(go|py)|(^|\/)test_[^/]*\.py)$/;
const ASSERTION = /\bexpect\s*\(|\bassert\w*\s*[.(]|\.should\b|\bt\.(is|deepEqual|true|false|throws)\s*\(|\bassert\s/;

export interface WeakenedTest {
  file: string;
  /** Assertion lines removed and added in this file. */
  removed: number;
  added: number;
}

/** From a unified diff: test files that lost more assertion lines than they gained, a deleted test file included. */
export function weakenedTests(patch: string): WeakenedTest[] {
  const found = new Map<string, WeakenedTest>();
  let file: string | null = null;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\//.exec(line);
    if (header) {
      file = TEST_FILE.test(header[1]!) ? header[1]! : null;
      continue;
    }
    if (!file || line.startsWith("---") || line.startsWith("+++")) continue;
    const sign = line[0];
    if ((sign !== "-" && sign !== "+") || !ASSERTION.test(line.slice(1))) continue;
    const t = found.get(file) ?? { file, removed: 0, added: 0 };
    if (sign === "-") t.removed++;
    else t.added++;
    found.set(file, t);
  }
  return [...found.values()].filter((t) => t.removed > t.added);
}

/** What the tester is told about them, or nothing. */
export function weakenedNote(tests: WeakenedTest[]): string {
  if (!tests.length) return "";
  const list = tests.map((t) => `${t.file} (${t.removed - t.added} fewer)`).join(", ");
  return `Test files that lost assertions in this turn: ${list}. Check each was not weakened to make it pass (a check removed, a number loosened, a case skipped); a weakened test is a problem to report.`;
}
