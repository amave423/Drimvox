import "@fontsource/onest/400.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/600.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/source-serif-4/500-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/components.css";
import "./styles/providers.css";
import "./styles/chat.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BootError } from "./ui/BootError";
import { createApi, ok } from "./api";
import { guessLocale } from "./i18n";
import type { Settings } from "@artel/shared";
import type { CoreStatus } from "./context";

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  const locale = guessLocale(navigator.languages);

  if (!window.artel) {
    root.render(<BootError locale={locale} reason="noToken" />);
    return;
  }
  try {
    const token = await window.artel.getToken();
    const api = createApi(token);
    const [settings, status] = await Promise.all([
      ok<Settings>(await api.settings.$get()),
      ok<CoreStatus>(await api.status.$get()),
    ]);
    root.render(
      <StrictMode>
        <App api={api} token={token} initialSettings={settings} status={status} />
      </StrictMode>,
    );
  } catch (err) {
    root.render(<BootError locale={locale} reason="failed" detail={String(err)} />);
  }
}

void boot();
