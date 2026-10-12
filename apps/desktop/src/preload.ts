import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("artel", {
  getToken: (): Promise<string> => ipcRenderer.invoke("artel:token"),
  setTitleBar: (colors: { background: string; symbols: string }) => ipcRenderer.send("artel:titlebar", colors),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("artel:pick-folder"),
  notify: (notice: { title: string; body: string; taskId: string }) => ipcRenderer.send("artel:notify", notice),
  onOpenTask: (listener: (taskId: string) => void) => {
    const handler = (_event: unknown, taskId: unknown) => typeof taskId === "string" && listener(taskId);
    ipcRenderer.on("artel:open-task", handler);
    return () => void ipcRenderer.removeListener("artel:open-task", handler);
  },
});
