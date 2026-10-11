/** Bridge exposed by the desktop preload script. Absent when the UI runs in a plain browser. */
interface ArtelBridge {
  getToken(): Promise<string>;
  setTitleBar(colors: { background: string; symbols: string }): void;
}

interface Window {
  artel?: ArtelBridge;
}
