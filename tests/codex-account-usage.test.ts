import { describe, expect, test } from "bun:test";
import { rollupCodexAccountUsage7d } from "../src/codex/account-usage";
import type { PersistedUsageEntry } from "../src/usage/log";

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const config = {
  codexAccounts: [
    { id: "pool-a", email: "a@example.test", isMain: false, logLabel: "p111111" },
    { id: "pool-b", email: "b@example.test", isMain: false, logLabel: "p222222" },
  ],
  codexAccountNamespaces: { work: "pool-a", "team-work": "pool-b", desktop: "@main" },
};

function row(overrides: Partial<PersistedUsageEntry>): PersistedUsageEntry {
  return {
    requestId: crypto.randomUUID(),
    timestamp: NOW - 1000,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 100, outputTokens: 10 },
    ...overrides,
  };
}

describe("rollupCodexAccountUsage7d", () => {
  test("attributes new explicit refs and legacy provider labels without exposing raw ids", () => {
    const result = rollupCodexAccountUsage7d([
      row({ codexAccountRef: "p111111" }),
      row({ provider: "chatgpt-p222222" }),
      row({ provider: "openai-work" }),
      row({ provider: "openai-team-work" }),
      row({ provider: "openai" }),
      row({ provider: "openai-main" }),
      row({ provider: "openai-desktop" }),
      row({ provider: "openai", codexAccountRef: "caller" }),
      row({ provider: "openai-apikey" }),
    ], config, NOW);

    expect(result.byAccountId.get("pool-a")?.requests).toBe(2);
    expect(result.byAccountId.get("pool-b")?.requests).toBe(2);
    expect(result.byAccountId.get("__main__")?.requests).toBe(3);
    expect([...result.byAccountId.keys()]).toEqual(["__main__", "pool-a", "pool-b"]);
  });

  test("sums API list-price equivalent and reports unpriced and unmetered coverage", () => {
    const result = rollupCodexAccountUsage7d([
      row({ codexAccountRef: "p111111", usage: { inputTokens: 100, outputTokens: 10 } }),
      row({ codexAccountRef: "p111111", model: "unknown-price" }),
      row({ codexAccountRef: "p111111", usageStatus: "unreported", usage: undefined }),
      row({ codexAccountRef: "p111111", timestamp: NOW - 7 * 24 * 60 * 60 * 1000 - 1 }),
    ], config, NOW);
    const usage = result.byAccountId.get("pool-a")!;

    expect(usage).toMatchObject({
      requests: 3,
      pricedRequests: 1,
      unpricedRequests: 1,
      unmeteredRequests: 1,
      totalTokens: 220,
    });
    expect(usage.estimatedCostUsd).toBeCloseTo((100 * 5 + 10 * 30) / 1e6, 9);
  });

  test("combo attempts can split one request across accounts without double-counting an account", () => {
    const result = rollupCodexAccountUsage7d([
      row({
        provider: "combo",
        model: "combo/native",
        attempts: [
          { ordinal: 1, provider: "openai-p111111", model: "gpt-5.5", codexAccountRef: "p111111", adapter: "openai-responses", status: 429, durationMs: 2, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 1 } },
          { ordinal: 2, provider: "openai-p111111", model: "gpt-5.5", codexAccountRef: "p111111", adapter: "openai-responses", status: 429, durationMs: 2, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 20, outputTokens: 2 } },
          { ordinal: 3, provider: "openai-p222222", model: "gpt-5.5", codexAccountRef: "p222222", adapter: "openai-responses", status: 200, durationMs: 2, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 30, outputTokens: 3 } },
        ],
      }),
    ], config, NOW);

    expect(result.byAccountId.get("pool-a")).toMatchObject({ requests: 1, pricedRequests: 1, totalTokens: 33 });
    expect(result.byAccountId.get("pool-b")).toMatchObject({ requests: 1, pricedRequests: 1, totalTokens: 33 });
  });

  test("direct mode does not guess that an unmarked base OpenAI row belongs to main", () => {
    const result = rollupCodexAccountUsage7d([
      row({ provider: "openai" }),
      row({ provider: "openai", codexAccountRef: "main" }),
    ], { ...config, codexAccountMode: "direct" }, NOW);
    expect(result.byAccountId.get("__main__")?.requests).toBe(1);
  });
});
