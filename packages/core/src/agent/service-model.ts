import type { Connection } from "../providers/repo";

type Pick = () => { conn: Connection; model: string } | null;
let chosen: Pick = () => null;

/** Where the cheaper model for the work around the work comes from (the settings' serviceModel). */
export function setServiceModel(pick: Pick): void {
  chosen = pick;
}

/**
 * The model for sub-agents' research, summaries of long histories and the code review (asked for: fewer tokens, the same
 * quality of what is built): the one in the settings when it is set and its provider is there, else the working one.
 */
export function serviceModel(conn: Connection, model: string): { conn: Connection; model: string } {
  try {
    return chosen() ?? { conn, model };
  } catch {
    return { conn, model };
  }
}
