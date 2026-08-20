import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n/provider";
import { detectInitial, ensureLocaleLoaded, hasBootCachedLocale, isLocaleLoaded } from "./i18n/shared";
import { installVitePreloadRecovery } from "./preload-recovery";
import "./styles.css";

// A tab can outlive a production deployment. If it later lazy-loads a route,
// its old hashed chunk may no longer be the current one; reload once into the
// new HTML/build instead of surfacing an opaque dynamic-import failure.
installVitePreloadRecovery({ buildKey: import.meta.url });

// First-visit vs cached-visit boot:
// - No boot-cache marker: the locale chunk has never been fetched, so waiting
//   would stall first paint behind a slow download. Render the English fallback
//   immediately; the provider fetches the locale in the background, shows the
//   native loading notice, and flips once it lands.
// - Marker present: the chunk is almost certainly in the browser HTTP cache,
//   so waiting costs a blink and prevents an English flash entirely.
// Fail open in both cases: a chunk that cannot arrive renders English.
const initialLocale = detectInitial();
if (hasBootCachedLocale(initialLocale) && !isLocaleLoaded(initialLocale)) {
  await ensureLocaleLoaded(initialLocale).catch(() => {
    /* fall back to English instead of a blank page */
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>
);
