import { expect, test } from "bun:test";
import { LOCALE_LOADING_TEXT } from "../src/i18n/provider";

/**
 * First paint must never flash English when a non-English locale is active.
 * main.tsx awaits the locale catalog before rendering, and index.html shows a
 * native-language boot notice during that window. These are source-level pins:
 * the behavioural proof for the lazy catalog itself lives in
 * locale-lazy-loading.test.tsx.
 */

test("main.tsx waits for the locale only when a previous session cached it", async () => {
  const main = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
  expect(main).toContain("const initialLocale = detectInitial();");
  const gateAt = main.indexOf("hasBootCachedLocale(initialLocale)");
  expect(gateAt).toBeGreaterThan(-1);
  const awaitAt = main.indexOf("await ensureLocaleLoaded(initialLocale)");
  expect(awaitAt).toBeGreaterThan(-1);
  // The wait is gated on the marker, happens before React mounts, and fails
  // open to the English fallback.
  expect(gateAt).toBeLessThan(awaitAt);
  expect(awaitAt).toBeLessThan(main.indexOf("ReactDOM.createRoot"));
  expect(main).toContain(".catch(");
});

test("index.html ships the native boot notice for every non-English locale", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).toContain('id="root"');
  for (const [locale, text] of Object.entries(LOCALE_LOADING_TEXT)) {
    if (locale === "en") continue;
    expect(html, locale).toContain(text);
  }
});

test("index.html skips the boot notice when a stored catalog exists", async () => {
  // Repeat visits seed the locale synchronously from localStorage, so the
  // static notice must stay silent whenever a catalog entry is already stored.
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).toContain('key.indexOf("ocx-locale-catalog:") === 0');
  expect(html).toContain("cached = true");
  expect(html).toContain("if (text && !cached)");
});
