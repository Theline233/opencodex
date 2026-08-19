import { en, type TKey } from "./en";
import { LAB_CATALOG_OVERRIDES, type LabLocale } from "./lab-translations";

/** React-free locale catalog registry for formatters and other shared helpers. */
export type Locale = LabLocale;

function withLabTranslations(locale: Locale, catalog: Record<TKey, string>): Record<TKey, string> {
  return { ...catalog, ...LAB_CATALOG_OVERRIDES[locale] };
}

const EN_DICT = withLabTranslations("en", en);

/**
 * Native language names shown by the language picker. Kept as a tiny static
 * table instead of reading the catalogs: a catalog chunk may still be in
 * flight while the picker renders, and the picker must never flash "English"
 * for every language during that window.
 */
const NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  ko: "한국어",
  zh: "中文",
  "zh-TW": "繁體中文",
  ru: "Русский",
  ja: "日本語",
  tr: "Türkçe",
};

/**
 * Per-locale lazy chunk loaders. Only English ships in the entry bundle; the
 * other eight catalogs download on first use, which is what keeps the main
 * JavaScript chunk from carrying all nine dictionaries.
 */
const CATALOG_LOADERS: Record<Exclude<Locale, "en">, () => Promise<Record<TKey, string>>> = {
  de: () => import("./de").then(m => m.de),
  fr: () => import("./fr").then(m => m.fr),
  ko: () => import("./ko").then(m => m.ko),
  zh: () => import("./zh").then(m => m.zh),
  "zh-TW": () => import("./zh-TW").then(m => m.zhTW),
  ru: () => import("./ru").then(m => m.ru),
  ja: () => import("./ja").then(m => m.ja),
  tr: () => import("./tr").then(m => m.tr),
};

/**
 * Synchronous dictionary table. Until a non-English chunk lands, its entry
 * points at the English overlay, so every existing synchronous reader keeps
 * working and simply renders the fallback language in the meantime. Loaded
 * entries are replaced in place, never mutated.
 */
export const DICTS: Record<Locale, Record<TKey, string>> = {
  en: EN_DICT,
  de: EN_DICT,
  fr: EN_DICT,
  ko: EN_DICT,
  zh: EN_DICT,
  "zh-TW": EN_DICT,
  ru: EN_DICT,
  ja: EN_DICT,
  tr: EN_DICT,
};

const loadedLocales = new Set<Locale>(["en"]);
const inflight = new Map<Locale, Promise<void>>();
let localeVersion = 0;
const subscribers = new Set<() => void>();

export function isLocaleLoaded(locale: Locale): boolean {
  return loadedLocales.has(locale);
}

/**
 * Boot-cache marker for one locale. Written once that locale's chunk has been
 * fetched successfully. On later visits the chunk is almost certainly still in
 * the browser HTTP cache, so first paint can afford to wait for it instead of
 * flashing the English fallback. A missing marker (very first visit, or after
 * clearing site data) means "fetch in the background" instead.
 */
export function hasBootCachedLocale(locale: Locale): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(`ocx-locale-cached:${locale}`) === "1";
  } catch {
    return false;
  }
}

/** Load a locale catalog exactly once; safe to call repeatedly or concurrently. */
export function ensureLocaleLoaded(locale: Locale): Promise<void> {
  if (loadedLocales.has(locale)) return Promise.resolve();
  const existing = inflight.get(locale);
  if (existing) return existing;
  // "en" is always loaded, so every remaining locale has a loader entry.
  const loader = CATALOG_LOADERS[locale as Exclude<Locale, "en">];
  const load = loader()
    .then(catalog => {
      DICTS[locale] = withLabTranslations(locale, catalog);
      loadedLocales.add(locale);
      localeVersion += 1;
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(`ocx-locale-cached:${locale}`, "1");
        }
      } catch { /* storage may be unavailable; the marker is only an optimization */ }
      for (const notify of subscribers) notify();
    })
    .finally(() => {
      inflight.delete(locale);
    });
  inflight.set(locale, load);
  return load;
}

/** Subscribe to catalog arrival so React surfaces can re-render when DICTS mutates. */
export function subscribeLocaleLoads(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function getLocaleVersion(): number {
  return localeVersion;
}

export function localeDisplayName(locale: Locale): string {
  return NATIVE_NAMES[locale];
}

export function catalogValue(locale: Locale, key: TKey): string {
  return DICTS[locale][key];
}

/**
 * Test-only reset: drop every non-English catalog so tests can exercise the
 * lazy path deterministically. Mirrors the reset helpers the rest of the
 * suite already uses; production code never calls it.
 */
export function __resetLocaleLoadStateForTests(): void {
  for (const key of Object.keys(DICTS) as Locale[]) {
    if (key !== "en") DICTS[key] = EN_DICT;
  }
  loadedLocales.clear();
  loadedLocales.add("en");
  inflight.clear();
  localeVersion += 1;
  for (const notify of subscribers) notify();
}

export type { TKey };
