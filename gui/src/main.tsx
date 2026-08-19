import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n/provider";
import { detectInitial, ensureLocaleLoaded, isLocaleLoaded } from "./i18n/shared";
import "./styles.css";

// Wait for the active locale catalog before first paint. Rendering the English
// fallback first would flash English and then flip, which reads as the page
// "reloading" on every visit. index.html shows a native-language boot notice
// during this window. Fail open: if the chunk cannot arrive, render with the
// English fallback rather than leaving a blank page.
const initialLocale = detectInitial();
if (!isLocaleLoaded(initialLocale)) {
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
