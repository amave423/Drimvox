/** Bridge exposed by the desktop preload script. Absent when the UI runs in a plain browser. */
interface ArtelBridge {
  getToken(): Promise<string>;
  setTitleBar(colors: { background: string; symbols: string }): void;
  /** Native folder picker; null when the user cancels. */
  pickFolder(): Promise<string | null>;
  /** A Windows notification; shown only while the window is not in front. */
  notify(notice: { title: string; body: string; taskId: string }): void;
  /** A notification right now, even with the window in front: to check that they reach the desktop. */
  testNotify(notice: { title: string; body: string }): void;
  /** A newer version found on GitHub, as far as it got; null when there is none. */
  updateState(): Promise<UpdateState | null>;
  onUpdate(listener: (state: UpdateState) => void): () => void;
  /** Restarts into the downloaded version. */
  installUpdate(): void;
  /** Opens Artel's shared skills folder in Explorer. */
  openSkillsFolder(): void;
  /** Called when the user clicks a notification; returns a function that stops listening. */
  onOpenTask(listener: (taskId: string) => void): () => void;
}

interface UpdateState {
  state: "downloading" | "ready" | "manual";
  version: string;
  percent?: number;
  url?: string;
}

interface Window {
  artel?: ArtelBridge;
}
