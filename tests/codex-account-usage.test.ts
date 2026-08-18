import { describe, expect, test } from "bun:test";
import {
  estimateCodexAccountWeeklyCapacities,
  rollupCodexAccountUsage7d,
} from "../src/codex/account-usage";
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
  test("attributes durable account labels and legacy provider labels without exposing raw ids", () => {
    const result = rollupCodexAccountUsage7d([
      row({ accountLogLabel: "p111111" }),
      row({ provider: "chatgpt-p222222" }),
      row({ provider: "openai-work" }),
      row({ provider: "openai-team-work" }),
      row({ provider: "openai" }),
      row({ provider: "openai-main" }),
      row({ provider: "openai-desktop" }),
      row({ provider: "openai-apikey" }),
    ], config, NOW);

    expect(result.byAccountId.get("pool-a")?.requests).toBe(2);
    expect(result.byAccountId.get("pool-b")?.requests).toBe(2);
    expect(result.byAccountId.get("__main__")?.requests).toBe(3);
    expect([...result.byAccountId.keys()]).toEqual(["__main__", "pool-a", "pool-b"]);
  });

  test("sums API list-price equivalent and reports unpriced and unmetered coverage", () => {
    const result = rollupCodexAccountUsage7d([
      row({ accountLogLabel: "p111111", usage: { inputTokens: 100, outputTokens: 10 } }),
      row({ accountLogLabel: "p111111", model: "unknown-price" }),
      row({ accountLogLabel: "p111111", usageStatus: "unreported", usage: undefined }),
      row({ accountLogLabel: "p111111", timestamp: NOW - 7 * 24 * 60 * 60 * 1000 - 1 }),
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
          { ordinal: 1, provider: "openai-p111111", model: "gpt-5.5", accountLogLabel: "p111111", adapter: "openai-responses", status: 429, durationMs: 2, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 1 } },
          { ordinal: 2, provider: "openai-p111111", model: "gpt-5.5", accountLogLabel: "p111111", adapter: "openai-responses", status: 429, durationMs: 2, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 20, outputTokens: 2 } },
          { ordinal: 3, provider: "openai-p222222", model: "gpt-5.5", accountLogLabel: "p222222", adapter: "openai-responses", status: 200, durationMs: 2, sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 30, outputTokens: 3 } },
        ],
      }),
    ], config, NOW);

    expect(result.byAccountId.get("pool-a")).toMatchObject({ requests: 1, pricedRequests: 1, totalTokens: 33 });
    expect(result.byAccountId.get("pool-b")).toMatchObject({ requests: 1, pricedRequests: 1, totalTokens: 33 });
  });

  test("direct mode does not guess that an unmarked base OpenAI row belongs to main", () => {
    const result = rollupCodexAccountUsage7d([
      row({ provider: "openai" }),
      row({ provider: "openai", accountLogLabel: "main" }),
    ], { ...config, codexAccountMode: "direct" }, NOW);
    expect(result.byAccountId.get("__main__")?.requests).toBe(1);
  });
});

describe("estimateCodexAccountWeeklyCapacities", () => {
  test("uses each account's own reset cycle and estimates API-equivalent total independently", () => {
    const resetA = NOW + 2 * 24 * 60 * 60 * 1000;
    const resetB = NOW + 5 * 24 * 60 * 60 * 1000;
    const cycleStartA = resetA - 7 * 24 * 60 * 60 * 1000;
    const result = estimateCodexAccountWeeklyCapacities([
      row({ accountLogLabel: "p111111", timestamp: cycleStartA - 1 }),
      row({ accountLogLabel: "p111111", timestamp: cycleStartA + 1 }),
      row({ accountLogLabel: "p222222", timestamp: NOW - 1000 }),
    ], config, new Map([
      ["pool-a", { weeklyPercent: 20, weeklyResetAt: resetA / 1000 }],
      ["pool-b", { weeklyPercent: 40, weeklyResetAt: resetB / 1000 }],
    ]), false, NOW);

    const accountA = result.byAccountId.get("pool-a")!;
    const accountB = result.byAccountId.get("pool-b")!;
    expect(accountA.requests).toBe(1);
    expect(accountB.requests).toBe(1);
    expect(accountA.cycleStartAt).toBe(cycleStartA);
    expect(accountA.estimatedTotalCostUsd).toBeCloseTo(accountA.observedCostUsd / 0.2, 12);
    expect(accountB.estimatedTotalCostUsd).toBeCloseTo(accountB.observedCostUsd / 0.4, 12);
    expect(accountA.estimatedRemainingCostUsd).toBeCloseTo(accountA.estimatedTotalCostUsd! - accountA.observedCostUsd, 12);
    expect(accountA.confidence).toBe("medium");
  });

  test("collects until five percent and lowers confidence for incomplete pricing coverage", () => {
    const resetAt = NOW + 4 * 24 * 60 * 60 * 1000;
    const collecting = estimateCodexAccountWeeklyCapacities([
      row({ accountLogLabel: "p111111" }),
    ], config, new Map([
      ["pool-a", { weeklyPercent: 4.99, weeklyResetAt: resetAt / 1000 }],
    ]), false, NOW).byAccountId.get("pool-a")!;
    expect(collecting.confidence).toBe("collecting");
    expect(collecting.estimatedTotalCostUsd).toBeUndefined();

    const incomplete = estimateCodexAccountWeeklyCapacities([
      row({ accountLogLabel: "p111111" }),
      row({ accountLogLabel: "p111111", model: "unknown-price" }),
    ], config, new Map([
      ["pool-a", { weeklyPercent: 35, weeklyResetAt: resetAt / 1000 }],
    ]), false, NOW).byAccountId.get("pool-a")!;
    expect(incomplete.priceCoverageRatio).toBe(0.5);
    expect(incomplete.confidence).toBe("low");
    expect(incomplete.estimatedTotalCostUsd).toBeGreaterThan(incomplete.observedCostUsd);
  });

  test("ignores stale, missing, and non-weekly quota snapshots", () => {
    const result = estimateCodexAccountWeeklyCapacities([], config, new Map([
      ["pool-a", { weeklyPercent: 20, weeklyResetAt: (NOW - 1) / 1000 }],
      ["pool-b", { weeklyPercent: undefined, weeklyResetAt: (NOW + 1000) / 1000 }],
    ]), false, NOW);
    expect(result.byAccountId.size).toBe(0);
  });
});
