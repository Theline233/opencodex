import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { CodexAccountUsage7d } from "../src/components/codex-account-usage";
import { LanguageProvider } from "../src/i18n/provider";
import { ensureLocaleLoaded } from "../src/i18n/catalogs";

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

test("account card labels the seven-day cost as an API list-price equivalent and exposes gaps", async () => {
  await ensureLocaleLoaded("zh");
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountUsage7d account={{
          id: "pool-a", email: "a@example.test", isMain: false, paused: false, hasCredential: true, quota: null,
          usage7d: { requests: 5, pricedRequests: 3, unpricedRequests: 1, unmeteredRequests: 1, totalTokens: 1000, estimatedCostUsd: 1.2345 },
          weeklyCapacity: {
            cycleStartAt: 1,
            resetAt: 2,
            usedPercent: 25,
            requests: 4,
            pricedRequests: 4,
            unpricedRequests: 0,
            unmeteredRequests: 0,
            totalTokens: 800,
            observedCostUsd: 1.25,
            priceCoverageRatio: 1,
            estimatedTotalCostUsd: 5,
            estimatedRemainingCostUsd: 3.75,
            confidence: "medium",
          },
          usageHistoryTruncated: true,
        }} />
      </LanguageProvider>,
    );
  });

  expect(host.textContent).toContain("近 7 天 API 标价等价值");
  expect(host.textContent).toContain("七天周期总额估算");
  expect(host.textContent).toContain("~US$5.0000");
  expect(host.textContent).toContain("已观测 ~US$1.2500 / 已用 25%");
  expect(host.textContent).toContain("预估剩余 ~US$3.7500");
  expect(host.textContent).toContain("中可信度");
  expect(host.textContent).toContain("~US$1.2345");
  expect(host.textContent).toContain("5 次请求");
  expect(host.textContent).toContain("2 次无法估价");
  expect(host.textContent).toContain("仅统计可用历史");
  expect(host.querySelector(".codex-account-usage:not(.codex-account-capacity)")?.getAttribute("title")).toContain("并非 ChatGPT Plus 实际扣费");
  expect(host.querySelector(".codex-account-capacity")?.getAttribute("title")).toContain("不是实际账单");
});
