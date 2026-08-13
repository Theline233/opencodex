import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { CodexSubscriptionStatus } from "../src/components/codex-subscription-status";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "zh-CN" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM?.close?.();
});

async function renderStatus(activeUntil: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexSubscriptionStatus
          account={{
            id: "pool-a", email: "account@example.test", isMain: false, paused: false,
            hasCredential: true, quota: null, subscription: { plan: "plus", activeUntil },
          }}
        />
      </LanguageProvider>,
    );
  });
}

test("shows the expiry as a prominent status row without a per-account refresh button", async () => {
  await renderStatus(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
  const status = host.querySelector(".codex-subscription-status");
  expect(status?.className).toContain("codex-subscription-status--active");
  expect(status?.querySelector(".codex-subscription-status__date")?.textContent).toBeTruthy();
  expect(status?.querySelector("button")).toBeNull();
});

test("uses urgent and expired visual states", async () => {
  await renderStatus(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString());
  expect(host.querySelector(".codex-subscription-status")?.className).toContain("--urgent");

  await act(async () => { root!.unmount(); });
  root = null;
  await renderStatus(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
  expect(host.querySelector(".codex-subscription-status")?.className).toContain("--expired");
});
