import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import MainAccountLoginModal from "../src/components/MainAccountLoginModal";
import { LanguageProvider } from "../src/i18n/provider";

const AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE = "ABCD-EFGHJ";
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let clipboardWrites: string[];
let fetchCalls: Array<{ path: string; method: string; body: string }>;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  clipboardWrites = [];
  fetchCalls = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      fetchCalls.push({ path: url.pathname, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (url.pathname === "/api/native-main-login/start" || url.pathname === "/api/native-main-login/status") {
        return Response.json({
          flowId: "flow-main",
          status: "waiting",
          verificationUri: AUTH_URL,
          userCode: DEVICE_CODE,
          expiresAt: Date.now() + 60_000,
        });
      }
      return Response.json({ ok: true });
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM?.close?.();
});

async function mountModal() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <MainAccountLoginModal apiBase="" onClose={() => {}} onLoggedIn={() => {}} />
      </LanguageProvider>,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

test("main account login modal shows the official URL and device code", async () => {
  await mountModal();
  expect(host.textContent).toContain("Log in to the main account");
  expect(host.textContent).toContain(AUTH_URL);
  expect(host.textContent).toContain(DEVICE_CODE);
  const link = host.querySelector(`a[href="${AUTH_URL}"]`);
  expect(link?.getAttribute("target")).toBe("_blank");
});

test("main account device code can be copied without entering an error state", async () => {
  await mountModal();
  const codeButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("Copy code"));
  expect(codeButton).toBeTruthy();
  await act(async () => {
    codeButton?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(clipboardWrites).toEqual([DEVICE_CODE]);
  expect(host.textContent).toContain("Code copied");
  expect(host.querySelector(".notice-err")).toBeNull();
});

test("unmounting the main account login modal cancels its staged device flow", async () => {
  await mountModal();
  const current = root;
  expect(current).toBeTruthy();
  await act(async () => {
    current?.unmount();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  root = null;
  expect(fetchCalls).toContainEqual({
    path: "/api/native-main-login/cancel",
    method: "POST",
    body: JSON.stringify({ flowId: "flow-main" }),
  });
});
