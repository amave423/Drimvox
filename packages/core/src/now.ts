/**
 * Models do not know what day it is. Every chat and agent run is told the date, the time and the time zone
 * of the computer Artel runs on.
 */
export function nowLine(at = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", hourCycle: "h23" }).format(at);
  const minutes = -at.getTimezoneOffset();
  const offset = `UTC${minutes >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  return `Current date and time: ${when} (${zone}, ${offset}).`;
}
