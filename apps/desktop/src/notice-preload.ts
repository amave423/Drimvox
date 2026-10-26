import { contextBridge, ipcRenderer } from "electron";

/** The notifications window's bridge: it hears notifications, says how tall it is, and which one was clicked. */
contextBridge.exposeInMainWorld("drimvoxNotice", {
  onNotice: (listener: (notice: unknown) => void) => {
    const handler = (_event: unknown, notice: unknown) => listener(notice);
    ipcRenderer.on("drimvox:notice", handler);
    return () => void ipcRenderer.removeListener("drimvox:notice", handler);
  },
  open: (id: string) => ipcRenderer.send("drimvox:notice-open", id),
  size: (height: number) => ipcRenderer.send("drimvox:notice-size", height),
});
