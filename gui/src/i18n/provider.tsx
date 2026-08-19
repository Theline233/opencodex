import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { DICTS, I18nContext, LOCALES, detectInitial, ensureLocaleLoaded, getLocaleVersion, interpolate, isLocaleLoaded, setActiveLocale, subscribeLocaleLoads, type Locale, type TFn, type TKey, type Vars } from "./shared";
import { en } from "./en";
import { useI18n } from "./shared";

/**
 * Native-language notice shown while the selected locale's catalog chunk is
 * still downloading. Hardcoded per locale: the catalog for that locale is
 * precisely what has not arrived yet, so it cannot be asked for this text.
 */
const LOCALE_LOADING_TEXT: Record<Locale, string> = {
  en: "Loading English…",
  de: "Deutsch wird geladen…",
  fr: "Chargement du français…",
  ko: "한국어를 불러오는 중…",
  zh: "正在加载中文语言包…",
  "zh-TW": "正在載入繁體中文語言包…",
  ru: "Загрузка русского языка…",
  ja: "日本語を読み込み中…",
  tr: "Türkçe yükleniyor…",
};

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(() => {
    const initial = detectInitial();
    setActiveLocale(initial);
    return initial;
  });
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);

  // Catalog chunks mutate DICTS in place; the version bump re-renders every
  // surface so already-rendered strings flip to the target language.
  // The third argument keeps server rendering working: SSR snapshots the same
  // counter and the client reconciles once the catalog chunk lands.
  const localeVersion = useSyncExternalStore(subscribeLocaleLoads, getLocaleVersion, getLocaleVersion);

  useEffect(() => {
    if (isLocaleLoaded(locale)) return;
    let cancelled = false;
    setPendingLocale(locale);
    void ensureLocaleLoaded(locale).finally(() => {
      if (!cancelled) {
        setPendingLocale(current => (current === locale ? null : current));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    setLocaleState(next);
  }, []);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem("ocx-lang", locale); } catch { /* ignore */ }
  }, [locale]);

  const t: TFn = useCallback(
    (key, vars) => interpolate(DICTS[locale][key] ?? en[key] ?? key, vars),
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, localeVersion, t]);

  return (
    <I18nContext.Provider value={value}>
      {children}
      {pendingLocale && (
        <div className="locale-loading" role="status" aria-live="polite">
          <span className="locale-loading__spinner" aria-hidden="true" />
          {LOCALE_LOADING_TEXT[pendingLocale]}
        </div>
      )}
    </I18nContext.Provider>
  );
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
