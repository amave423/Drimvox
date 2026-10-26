import "@fontsource/onest/400.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/600.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/source-serif-4/500-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/components.css";
import "./styles/providers.css";
import "./styles/chat.css";
import "./styles/tasks.css";
import "./styles/workshop.css";
import "./styles/media.css";
import "./styles/shape.css";
import "./styles/motion.css";
import "./styles/notice.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BootError } from "./ui/BootError";
import { NoticeStack } from "./notice/NoticeStack";
import { SignIn } from "./ui/SignIn";
import { createApi, ok } from "./api";
import { guessLocale } from "./i18n";
import type { Settings } from "@drimvox/shared";
import type { CoreStatus } from "./context";

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  // The notifications' own window: only the cards, no core to talk to.
  if (location.hash === "#notice" && window.drimvoxNotice) {
    document.documentElement.classList.add("is-notice");
    root.render(<NoticeStack bridge={window.drimvoxNotice} />);
    return;
  }
  const locale = guessLocale(navigator.languages);

  try {
    // The desktop window has a token; a browser on the server signs in with the password and keeps a cookie.
    const token = window.drimvox ? await window.drimvox.getToken() : null;
    const api = createApi(token);
    if (!token) {
      const res = await api.auth.state.$get().catch(() => null);
      const state = res?.ok ? await res.json() : null;
      if (state?.mode !== "password") {
        root.render(<BootError locale={locale} reason="noToken" />);
        return;
      }
      if (!state.signedIn) {
        root.render(<SignIn api={api} locale={locale} passwordSet={state.passwordSet} />);
        return;
      }
    }
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
