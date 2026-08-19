import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider, useI18n } from "../src/i18n";
import { DICTS, __resetLocaleLoadStateForTests, ensureLocaleLoaded, hasBootCachedLocale, isLocaleLoaded } from "../src/i18n/catalogs";

/**
 * Lazy locale catalogs: only English ships in the entry chunk. This pins the
 * contract the split relies on — non-English dictionaries arrive on demand,
 * already-rendered surfaces flip when they land, and the native-language
 * notice appears while the chunk is still in flight.
 */

function Probe() {
  const { locale, t } = useI18n();
  return (
    <div data-locale={locale}>
      <span data-nav>{t("nav.dashboard")}</span>
    </div>
  );
}

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "ja" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  __resetLocaleLoadStateForTests();
});

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM?.close?.();
});

test("non-English catalogs populate in place and leave the English fallback intact", async () => {
  expect(isLocaleLoaded("ja")).toBe(false);
  expect(DICTS.ja).toBe(DICTS.en);

  await ensureLocaleLoaded("ja");
  await ensureLocaleLoaded("ja"); // idempotent

  expect(isLocaleLoaded("ja")).toBe(true);
  expect(DICTS.ja["nav.dashboard"]).not.toBe(DICTS.en["nav.dashboard"]);
  expect(DICTS.ja["lang.nativeName"]).toBe("日本語");
  expect(DICTS.en["nav.dashboard"]).toBe("Dashboard");
});

test("a successful locale fetch records the boot-cache marker for later visits", async () => {
  expect(hasBootCachedLocale("ja")).toBe(false);
  await ensureLocaleLoaded("ja");
  expect(win.localStorage.getItem("ocx-locale-cached:ja")).toBe("1");
  expect(hasBootCachedLocale("ja")).toBe(true);
});

test("the provider shows the native loading notice, then flips once the chunk lands", async () => {
  const { createRoot } = await import("react-dom/client");
  act(() => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
  });

  // The chunk is still in flight during this synchronous window: the notice
  // is up and the nav label is still the English fallback.
  const notice = win.document.querySelector(".locale-loading");
  expect(notice).not.toBeNull();
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.textContent).toContain("日本語を読み込み中…");
  expect(host.querySelector("[data-nav]")?.textContent).toBe("Dashboard");

  await act(async () => {
    await ensureLocaleLoaded("ja");
  });

  expect(win.document.querySelector(".locale-loading")).toBeNull();
  expect(host.querySelector("[data-nav]")?.textContent).not.toBe("Dashboard");
  expect(host.querySelector("[data-nav]")?.textContent).toContain("ダッシュ");
});
