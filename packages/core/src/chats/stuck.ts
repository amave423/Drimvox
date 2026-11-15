import type { HistoryTurn } from "./repo";

/**
 * A chat stuck on the same failure (seen live: a VPN on the user's PC kept failing for hours while the model tried
 * server after server, client after client, and looked only at the processes of the VPN clients it expected; the cause
 * was a DPI-bypass tool, zapret, running on that PC, which it never listed). When the user keeps saying it still does
 * not work, the model is told to step back before changing the same layer again.
 */

/** The user's words for "it still fails", in Russian and English. */
const FAILED =
  /не работа|не грузит|не грузятся|не открыва|не удалось|не получилось|не подключ|не запуска|вс[её] так ?же|ничего не изменилось|опять то же|нихера|\bdoesn'?t work\b|\bnot working\b|\bstill (fails|the same|not)\b|\bsame error\b/i;

export const STUCK_NOTE =
  "[Drimvox: the user has said several times that it still does not work. Stop changing the same layer. List every cause that could explain it, the ones outside what you have touched so far too: other software on the user's computer that handles network traffic (another VPN or proxy, a DPI-bypass tool such as zapret, winws or GoodbyeDPI, an antivirus or firewall, a TUN or packet driver such as WinDivert), DNS, the provider. Check each with one command; on a computer, list all running processes, services and network drivers, not only the ones you expect. Search the web for the exact error. Ask the user about what you cannot see. Then say which cause it is and fix that one.]";

/** The note, when the user's newest message reports a failure again and at least two of the last three do. */
export function stuckNote(turns: HistoryTurn[]): string | null {
  const said = turns.filter((t) => t.role === "user").slice(-3);
  if (said.length < 2 || !FAILED.test(said.at(-1)!.content)) return null;
  return said.filter((t) => FAILED.test(t.content)).length >= 2 ? STUCK_NOTE : null;
}
