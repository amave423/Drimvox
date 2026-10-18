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

/**
 * The day only, for agents: their system prompt starts every request and must stay the same from step to step, or the
 * provider's cache does not hold (seen live: the minute in it sent a small site's 16.7M input tokens at full price).
 */
export function todayLine(at = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "full" }).format(at);
  return `Today is ${day} (${zone}).`;
}
