import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  clearPersistentListCache,
  clearSessionListCache,
  readPersistentListCache,
  readPersistentListCacheEntry,
  readSessionListCache,
  writePersistentListCache,
  writeSessionListCache,
} from "../src/session-list-cache";

const globals = ["document", "window", "navigator", "sessionStorage", "localStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

function install() {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  sessionStorage.clear();
  localStorage.clear();
}

function restore() {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
}

afterEach(restore);

test("session list cache round-trips non-secret JSON shapes", () => {
  install();
  writeSessionListCache("ocx.test", { range: "30d", surface: "claude", n: 3 });
  expect(readSessionListCache<{ range: string; surface: string; n: number }>("ocx.test")).toEqual({
    range: "30d",
    surface: "claude",
    n: 3,
  });
  clearSessionListCache("ocx.test");
  expect(readSessionListCache("ocx.test")).toBeNull();
});

test("session list cache returns null for corrupt JSON", () => {
  install();
  sessionStorage.setItem("ocx.bad", "{not-json");
  expect(readSessionListCache("ocx.bad")).toBeNull();
});

test("persistent list cache round-trips non-secret shapes with a write age", () => {
  install();
  writePersistentListCache("ocx.persist", { range: "30d", n: 3 });
  expect(readPersistentListCache<{ range: string; n: number }>("ocx.persist")).toEqual({
    range: "30d",
    n: 3,
  });
  const entry = readPersistentListCacheEntry<{ range: string; n: number }>("ocx.persist");
  expect(entry?.cachedAt).not.toBeNull();
  expect(typeof entry?.cachedAt).toBe("number");
  clearPersistentListCache("ocx.persist");
  expect(readPersistentListCache("ocx.persist")).toBeNull();
});

test("persistent list cache returns null for corrupt JSON", () => {
  install();
  localStorage.setItem("ocx.pbad", "{not-json");
  expect(readPersistentListCache("ocx.pbad")).toBeNull();
});

test("oversized persistent entries are dropped and evict any previous value", () => {
  install();
  writePersistentListCache("ocx.pbig", { small: true });
  expect(readPersistentListCache<{ small?: boolean; blob?: string }>("ocx.pbig")).toEqual({ small: true });

  writePersistentListCache("ocx.pbig", { blob: "x".repeat(600_000) });
  expect(readPersistentListCache("ocx.pbig")).toBeNull();
  expect(localStorage.getItem("ocx.pbig")).toBeNull();
});
