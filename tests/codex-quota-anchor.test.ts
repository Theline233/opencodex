import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import {
  runCodexQuotaAnchorSweep,
  type CodexQuotaAnchorStateFile,
} from "../src/codex/quota-anchor";

const NOW = Date.UTC(2026, 7, 22, 0, 0, 0);
const NEXT_RESET_SECONDS = (NOW + 7 * 24 * 60 * 60_000) / 1000;

function config(): OcxConfig {
  return { providers: {} } as OcxConfig;
}

function stateHarness(initial?: CodexQuotaAnchorStateFile) {
  let state = structuredClone(initial ?? { version: 1 as const, accounts: {} });
  return {
    loadState: () => structuredClone(state),
    saveState: (next: CodexQuotaAnchorStateFile) => { state = structuredClone(next); },
    current: () => structuredClone(state),
  };
}

describe("Codex zero-usage weekly quota anchor", () => {
  test("fresh weekly usage at exactly zero sends once and persists the next due time", async () => {
    const state = stateHarness();
    let refreshes = 0;
    let warmups = 0;
    const deps = {
      now: () => NOW,
      loadState: state.loadState,
      saveState: state.saveState,
      listTargets: () => [{ id: "pool-a" }],
      refreshQuota: async () => {
        refreshes += 1;
        return { weeklyPercent: 0, weeklyResetAt: NEXT_RESET_SECONDS };
      },
      warmAccount: async (_id: string, model: string) => {
        expect(model).toBe("gpt-5.6-luna");
        warmups += 1;
      },
    };

    const first = await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", deps);
    const second = await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", deps);

    expect(first).toMatchObject({ anchored: ["pool-a"], usagePresent: [], failed: [] });
    expect(second).toEqual({ anchored: [], usagePresent: [], failed: [], unknown: [] });
    expect(refreshes).toBe(1);
    expect(warmups).toBe(1);
    expect(state.current().accounts["pool-a"]).toMatchObject({
      nextDueAtMs: NEXT_RESET_SECONDS * 1000,
      lastAttemptedAtMs: NOW,
      status: "anchored",
    });
  });

  test("any positive weekly usage skips the request and tracks the upstream reset", async () => {
    const state = stateHarness();
    let warmups = 0;
    const result = await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", {
      now: () => NOW,
      loadState: state.loadState,
      saveState: state.saveState,
      listTargets: () => [{ id: "pool-used" }],
      refreshQuota: async () => ({ weeklyPercent: 0.01, weeklyResetAt: NEXT_RESET_SECONDS }),
      warmAccount: async () => { warmups += 1; },
    });

    expect(result).toEqual({ anchored: [], usagePresent: ["pool-used"], failed: [], unknown: [] });
    expect(warmups).toBe(0);
    expect(state.current().accounts["pool-used"]).toMatchObject({
      nextDueAtMs: NEXT_RESET_SECONDS * 1000,
      status: "usage-present",
    });
  });

  test("when a recorded reset becomes due, positive usage still suppresses anchoring", async () => {
    const state = stateHarness({
      version: 1,
      accounts: {
        "pool-active": {
          nextDueAtMs: NOW,
          lastCheckedAtMs: NOW - 1000,
          status: "usage-present",
        },
      },
    });
    let warmups = 0;
    await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", {
      now: () => NOW,
      loadState: state.loadState,
      saveState: state.saveState,
      listTargets: () => [{ id: "pool-active" }],
      refreshQuota: async () => ({ weeklyPercent: 3, weeklyResetAt: NEXT_RESET_SECONDS }),
      warmAccount: async () => { warmups += 1; },
    });
    expect(warmups).toBe(0);
    expect(state.current().accounts["pool-active"]?.nextDueAtMs).toBe(NEXT_RESET_SECONDS * 1000);
  });

  test("an attempted zero-usage anchor is not retried after a known failure", async () => {
    const state = stateHarness();
    let warmups = 0;
    const deps = {
      now: () => NOW,
      loadState: state.loadState,
      saveState: state.saveState,
      listTargets: () => [{ id: "pool-failed" }],
      refreshQuota: async () => ({ weeklyPercent: 0, weeklyResetAt: NEXT_RESET_SECONDS }),
      warmAccount: async () => {
        warmups += 1;
        throw new Error("network");
      },
    };

    const first = await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", deps);
    const second = await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", deps);

    expect(first.failed).toEqual(["pool-failed"]);
    expect(second.failed).toEqual([]);
    expect(warmups).toBe(1);
    expect(state.current().accounts["pool-failed"]).toMatchObject({
      status: "failed",
      lastFailureCode: "transport",
    });
  });

  test("unknown or stale quota evidence never authorizes a request", async () => {
    const state = stateHarness();
    let warmups = 0;
    const result = await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", {
      now: () => NOW,
      loadState: state.loadState,
      saveState: state.saveState,
      listTargets: () => [{ id: "pool-unknown" }],
      refreshQuota: async () => null,
      warmAccount: async () => { warmups += 1; },
    });
    expect(result.unknown).toEqual(["pool-unknown"]);
    expect(warmups).toBe(0);
  });

  test("a failed write-ahead save blocks the request", async () => {
    let warmups = 0;
    let saves = 0;
    let persisted: CodexQuotaAnchorStateFile | null = null;
    const result = await runCodexQuotaAnchorSweep(config(), "gpt-5.6-luna", {
      now: () => NOW,
      loadState: () => ({ version: 1, accounts: {} }),
      saveState: next => {
        saves += 1;
        if (saves === 1) throw new Error("disk full");
        persisted = structuredClone(next);
      },
      listTargets: () => [{ id: "pool-no-state" }],
      refreshQuota: async () => ({ weeklyPercent: 0, weeklyResetAt: NEXT_RESET_SECONDS }),
      warmAccount: async () => { warmups += 1; },
    });
    expect(result.failed).toEqual(["pool-no-state"]);
    expect(warmups).toBe(0);
    expect(persisted?.accounts).toEqual({});
  });
});
