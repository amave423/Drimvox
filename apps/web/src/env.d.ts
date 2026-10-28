/** Bridge exposed by the desktop preload script. Absent when the UI runs in a plain browser. */
interface DrimvoxBridge {
  getToken(): Promise<string>;
  setTitleBar(colors: { background: string; symbols: string }): void;
  /** Native folder picker; null when the user cancels. */
  pickFolder(): Promise<string | null>;
  savePdf?(name: string): Promise<string | null>;
  /** Drimvox's own notification; shown only while the window is not in front. A click opens the task or the project. */
  notify(notice: NoticeRequest & { taskId?: string; projectId?: string; chatId?: string }): void;
  /** A notification right now, even with the window in front: to check that they reach the desktop and sound. */
  testNotify(notice: NoticeRequest): void;
  /** Desktop: the agent's real browser tab is put over this box of the window; null takes it out of sight. */
  placeBrowser?(place: { x: number; y: number; width: number; height: number } | null): void;
  /** How notifications look and sound now, for the app's own notices (an update, the tray). */
  noticeLook?(look: Omit<NoticeRequest, "title" | "body">): void;
  /** Desktop: the keyboard back from the agent's tab to this page. */
  focusPage?(): void;
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
  onOpenProject?(listener: (projectId: string) => void): () => void;
  onOpenChat?(listener: (chatId: string) => void): () => void;
}

/** What a notification says and how it looks and sounds: the window's theme and mode, the settings' sound. */
interface NoticeRequest {
  title: string;
  body: string;
  dark: boolean;
  mode: "chat" | "projects";
  locale: "ru" | "en";
  sound: "drop" | "chime" | "soft" | "pop" | "off";
  volume: number;
}

/** A notification as its window gets it: with its id. */
interface DrimvoxNotice extends NoticeRequest {
  id: string;
}

/** The notifications window's own bridge (apps/desktop/src/notice-preload.ts). */
interface NoticeBridge {
  onNotice(listener: (notice: DrimvoxNotice) => void): () => void;
  /** The notification was clicked: Drimvox comes forward on what it is about. */
  open(id: string): void;
  /** How tall the cards are; 0 hides the window. */
  size(height: number): void;
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
  drimvoxNotice?: NoticeBridge;
}
