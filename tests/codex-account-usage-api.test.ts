import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexUsageCardCacheForTests,
  handleCodexAuthAPI,
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
});

afterEach(() => {
  clearCodexUsageCardCacheForTests();
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

  const request = new Request("http://localhost/api/codex-auth/accounts/usage");
  const response = await handleCodexAuthAPI(request, new URL(request.url), config);
  const body = await response!.json() as {
    range: string;
    historyTruncated: boolean;
    accounts: Array<{ id: string; usage7d: { requests: number; pricedRequests: number; estimatedCostUsd: number } }>;
  };

  expect(response?.status).toBe(200);
  expect(body.range).toBe("7d");
  expect(body.historyTruncated).toBe(false);
  expect(body.accounts.find(account => account.id === "pool-a")?.usage7d).toMatchObject({
    requests: 1,
    pricedRequests: 1,
  });
  expect(body.accounts.find(account => account.id === "pool-a")?.usage7d.estimatedCostUsd).toBeGreaterThan(0);
  expect(JSON.stringify(body)).not.toContain("private@example.test");
});
