import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexUsageCardCacheForTests,
  clearAccountQuota,
  handleCodexAuthAPI,
  setAccountQuotaFromParsed,
} from "../src/codex/auth-api";
import { appendUsageEntry, resetUsageReadCacheForTests } from "../src/usage/log";
import type { OcxConfig } from "../src/types";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-account-usage-api-"));
  process.env.OPENCODEX_HOME = home;
  resetUsageReadCacheForTests();
  clearCodexUsageCardCacheForTests();
  clearAccountQuota("pool-a");
});

afterEach(() => {
  clearCodexUsageCardCacheForTests();
  clearAccountQuota("pool-a");
  resetUsageReadCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

test("GET account usage returns a seven-day per-account list-price rollup", async () => {
  const config: OcxConfig = {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [{ id: "pool-a", email: "private@example.test", isMain: false, logLabel: "p123abc" }],
  };
  appendUsageEntry({
    requestId: "account-usage-api",
    timestamp: Date.now(),
    provider: "openai-p123abc",
    model: "gpt-5.5",
    accountLogLabel: "p123abc",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  setAccountQuotaFromParsed("pool-a", {
    weeklyPercent: 25,
    weeklyResetAt: Math.floor((Date.now() + 3 * 24 * 60 * 60_000) / 1000),
  });

  const request = new Request("http://localhost/api/codex-auth/accounts/usage");
  const response = await handleCodexAuthAPI(request, new URL(request.url), config);
  const body = await response!.json() as {
    range: string;
    historyTruncated: boolean;
    accounts: Array<{
      id: string;
      usage7d: { requests: number; pricedRequests: number; estimatedCostUsd: number };
      weeklyCapacity?: {
        usedPercent: number;
        observedCostUsd: number;
        estimatedTotalCostUsd?: number;
        estimatedRemainingCostUsd?: number;
      };
    }>;
  };

  expect(response?.status).toBe(200);
  expect(body.range).toBe("7d");
  expect(body.historyTruncated).toBe(false);
  expect(body.accounts.find(account => account.id === "pool-a")?.usage7d).toMatchObject({
    requests: 1,
    pricedRequests: 1,
  });
  expect(body.accounts.find(account => account.id === "pool-a")?.usage7d.estimatedCostUsd).toBeGreaterThan(0);
  const capacity = body.accounts.find(account => account.id === "pool-a")?.weeklyCapacity;
  expect(capacity).toMatchObject({ usedPercent: 25 });
  expect(capacity?.estimatedTotalCostUsd).toBeCloseTo(capacity!.observedCostUsd / 0.25, 12);
  expect(capacity?.estimatedRemainingCostUsd).toBeCloseTo(capacity!.estimatedTotalCostUsd! - capacity!.observedCostUsd, 12);
  expect(JSON.stringify(body)).not.toContain("private@example.test");

  // Quota can move while usage.jsonl is unchanged. The one-minute card cache must
  // include the authoritative percentage/reset pair in its identity.
  setAccountQuotaFromParsed("pool-a", {
    weeklyPercent: 50,
    weeklyResetAt: Math.floor((Date.now() + 3 * 24 * 60 * 60_000) / 1000),
  });
  const refreshed = await handleCodexAuthAPI(request, new URL(request.url), config);
  const refreshedBody = await refreshed!.json() as typeof body;
  const refreshedCapacity = refreshedBody.accounts.find(account => account.id === "pool-a")?.weeklyCapacity;
  expect(refreshedCapacity?.usedPercent).toBe(50);
  expect(refreshedCapacity?.estimatedTotalCostUsd).toBeCloseTo(refreshedCapacity!.observedCostUsd / 0.5, 12);
});
