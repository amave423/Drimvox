/** Bridge exposed by the desktop preload script. Absent when the UI runs in a plain browser. */
interface DrimvoxBridge {
  getToken(): Promise<string>;
  setTitleBar(colors: { background: string; symbols: string }): void;
  /** Native folder picker; null when the user cancels. */
  pickFolder(): Promise<string | null>;
  /** A Windows notification; shown only while the window is not in front. */
  notify(notice: { title: string; body: string; taskId: string }): void;
  /** A notification right now, even with the window in front: to check that they reach the desktop. */
  testNotify(notice: { title: string; body: string }): void;
  /** Windows' Focus Assist: 0 off, 1 priority only, 2 alarms only; null where it cannot be told. */
  focusAssist?(): Promise<number | null>;
  /** Where updating stands: checking, the latest, a newer version coming or ready, or what went wrong. */
  updateState(): Promise<UpdateState | null>;
  onUpdate(listener: (state: UpdateState) => void): () => void;
  /** Restarts into the downloaded version. */
  installUpdate(): void;
  /** Asks GitHub now instead of at the next check. */
  checkUpdates(): void;
  /** Opens Drimvox's shared skills folder in Explorer. */
  openSkillsFolder(): void;
  /** Called when the user clicks a notification; returns a function that stops listening. */
  onOpenTask(listener: (taskId: string) => void): () => void;
}

interface UpdateState {
  state: "off" | "idle" | "checking" | "latest" | "error" | "downloading" | "ready" | "manual";
  version: string;
  percent?: number;
  url?: string;
  message?: string;
  checkedAt?: number;
}

interface Window {
  drimvox?: DrimvoxBridge;
}
