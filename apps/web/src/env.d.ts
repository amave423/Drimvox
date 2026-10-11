/** Bridge exposed by the desktop preload script. Absent when the UI runs in a plain browser. */
interface ArtelBridge {
  getToken(): Promise<string>;
  setTitleBar(colors: { background: string; symbols: string }): void;
  /** Native folder picker; null when the user cancels. */
  pickFolder(): Promise<string | null>;
}

interface Window {
  artel?: ArtelBridge;
}
