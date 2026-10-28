import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("drimvox", {
  getToken: (): Promise<string> => ipcRenderer.invoke("drimvox:token"),
  setTitleBar: (colors: { background: string; symbols: string }) => ipcRenderer.send("drimvox:titlebar", colors),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("drimvox:pick-folder"),
  savePdf: (name: string): Promise<string | null> => ipcRenderer.invoke("drimvox:save-pdf", name),
  openSkillsFolder: () => ipcRenderer.send("drimvox:open-skills"),
  notify: (notice: unknown) => ipcRenderer.send("drimvox:notify", notice),
  testNotify: (notice: unknown) => ipcRenderer.send("drimvox:notify-test", notice),
  /** Where the browser panel's page box is; null when the panel closes. */
  placeBrowser: (place: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.send("drimvox:browser-place", place),
  /** Takes the keyboard back from the agent's tab to Drimvox's own page. */
  focusPage: () => ipcRenderer.send("drimvox:focus-page"),
  focusAssist: (): Promise<number | null> => ipcRenderer.invoke("drimvox:focus-assist"),
  updateState: () => ipcRenderer.invoke("drimvox:update-state"),
  onUpdate: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("drimvox:update", handler);
    return () => void ipcRenderer.removeListener("drimvox:update", handler);
  },
  installUpdate: () => ipcRenderer.send("drimvox:update-install"),
  checkUpdates: () => ipcRenderer.send("drimvox:update-check"),
  onOpenTask: (listener: (taskId: string) => void) => {
    const handler = (_event: unknown, taskId: unknown) => typeof taskId === "string" && listener(taskId);
    ipcRenderer.on("drimvox:open-task", handler);
    return () => void ipcRenderer.removeListener("drimvox:open-task", handler);
  },
  onOpenChat: (listener: (chatId: string) => void) => {
    const handler = (_event: unknown, chatId: unknown) => typeof chatId === "string" && listener(chatId);
    ipcRenderer.on("drimvox:open-chat", handler);
    return () => void ipcRenderer.removeListener("drimvox:open-chat", handler);
  },
  onOpenProject: (listener: (projectId: string) => void) => {
    const handler = (_event: unknown, projectId: unknown) => typeof projectId === "string" && listener(projectId);
    ipcRenderer.on("drimvox:open-project", handler);
    return () => void ipcRenderer.removeListener("drimvox:open-project", handler);
  },
});
