import { contextBridge, ipcRenderer } from "electron";

/**
 * Notifications that came before the page listened (seen on a Mac: the first one, sent right after the page loaded,
 * was lost before React had subscribed). The bridge hears them from the start and hands them over once asked.
 */
const early: unknown[] = [];
let listener: ((notice: unknown) => void) | null = null;
ipcRenderer.on("drimvox:notice", (_event: unknown, notice: unknown) => (listener ? listener(notice) : early.push(notice)));

/** The notifications window's bridge: it hears notifications, says how tall it is, and which one was clicked. */
contextBridge.exposeInMainWorld("drimvoxNotice", {
  onNotice: (next: (notice: unknown) => void) => {
    listener = next;
    for (const notice of early.splice(0)) next(notice);
    return () => {
      if (listener === next) listener = null;
    };
  },
  open: (id: string) => ipcRenderer.send("drimvox:notice-open", id),
  size: (height: number) => ipcRenderer.send("drimvox:notice-size", height),
});
