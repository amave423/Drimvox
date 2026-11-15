/**
 * The same tool called again and again with the same input, nothing changed in between (seen in a test of seven models
 * by a video the user sent: one ran the same command up to seven times in a run; our rule "never repeat the same tool
 * with the same arguments" was only words). On the third such call the agent is told, in the next step.
 */

/** Calls that change the files: what was read before them may read differently after. */
const CHANGES = /^(write_file|edit_file|apply_patch|delete_file|move_file)$/;
/** Calls made to wait or look again on purpose: a background process, a page loading. */
const WAITS = /^(read_background|browser_wait|app_wait|wait|sleep)$/;
export const REPEAT_LIMIT = 3;

export class Repeats {
  private readonly counts = new Map<string, number>();
  private epoch = 0;
  private pending: string | null = null;

  seen(calls: { toolName: string; input: unknown }[]): void {
    for (const call of calls) {
      if (CHANGES.test(call.toolName)) {
        this.epoch++;
        continue;
      }
      if (WAITS.test(call.toolName)) continue;
      const key = `${this.epoch}\u0000${call.toolName}\u0000${JSON.stringify(call.input ?? null)}`;
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      if (n === REPEAT_LIMIT)
        this.pending = `[Drimvox: you called ${call.toolName} with the same input ${n} times, nothing changed in between, so you already have its result. Use it, or try another way; if you are stuck, say what blocks you.]`;
    }
  }

  /** The note for the next step, once. */
  take(): string | null {
    const note = this.pending;
    this.pending = null;
    return note;
  }
}
