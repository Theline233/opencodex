import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import type { OcxConfig } from "../types";
import { getValidCodexToken, readCodexAccountRecord } from "./account-store";
import { fetchFreshCodexQuotaForAnchor } from "./auth-api";
import { isSelectableCodexPoolAccount, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { isCodexAccountPaused } from "./account-pause";
import { getMainAccountToken } from "./main-account";
import { tryAcquireNativeMainProfileClaim } from "./native-main-admission";
import type { StoredAccountQuota } from "./quota";
import { providerCodexAccountMode } from "../providers/registry";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { CodexWarmupError, warmCodexAccount } from "./warmup";

const STATE_FILENAME = "codex-quota-anchor-state.json";
const WEEK_MS = 7 * 24 * 60 * 60_000;

export type CodexQuotaAnchorStatus = "usage-present" | "attempting" | "anchored" | "failed";

export interface CodexQuotaAnchorAccountState {
  nextDueAtMs: number;
  lastCheckedAtMs: number;
  lastAttemptedAtMs?: number;
  status: CodexQuotaAnchorStatus;
  lastFailureCode?: string;
}

export interface CodexQuotaAnchorStateFile {
  version: 1;
  accounts: Record<string, CodexQuotaAnchorAccountState>;
}

export interface CodexQuotaAnchorResult {
  anchored: string[];
  usagePresent: string[];
  failed: string[];
  unknown: string[];
}

interface AnchorTarget {
  id: string;
}

export interface CodexQuotaAnchorDeps {
  now?: () => number;
  loadState?: () => CodexQuotaAnchorStateFile;
  saveState?: (state: CodexQuotaAnchorStateFile) => void;
  listTargets?: (config: OcxConfig) => AnchorTarget[];
  refreshQuota?: (
    config: OcxConfig,
    accountId: string,
  ) => Promise<Omit<StoredAccountQuota, "updatedAt"> | null>;
  warmAccount?: (accountId: string, model: string) => Promise<void>;
}

function emptyState(): CodexQuotaAnchorStateFile {
  return { version: 1, accounts: {} };
}

function statePath(): string {
  return join(getConfigDir(), STATE_FILENAME);
}

export function loadCodexQuotaAnchorState(): CodexQuotaAnchorStateFile {
  const path = statePath();
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as CodexQuotaAnchorStateFile;
  if (parsed?.version !== 1 || !parsed.accounts || typeof parsed.accounts !== "object") {
    throw new Error("invalid Codex quota anchor state");
  }
  for (const entry of Object.values(parsed.accounts)) {
    if (!entry || typeof entry !== "object"
      || typeof entry.nextDueAtMs !== "number" || !Number.isFinite(entry.nextDueAtMs)
      || typeof entry.lastCheckedAtMs !== "number" || !Number.isFinite(entry.lastCheckedAtMs)
      || !["usage-present", "attempting", "anchored", "failed"].includes(entry.status)) {
      throw new Error("invalid Codex quota anchor account state");
    }
  }
  return parsed;
}

export function saveCodexQuotaAnchorState(state: CodexQuotaAnchorStateFile): void {
  atomicWriteFile(statePath(), `${JSON.stringify(state)}\n`);
}

function unixResetAtMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function nextDue(resetAtMs: number, nowMs: number): number {
  return resetAtMs > nowMs ? resetAtMs : nowMs + WEEK_MS;
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof CodexWarmupError)) return "transport";
  return error.status ? `${error.code}:${error.status}` : error.code;
}

function defaultTargets(config: OcxConfig): AnchorTarget[] {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!openai || openai.disabled === true || !isCanonicalOpenAiForwardProvider(openai)) return [];

  const targets: AnchorTarget[] = [];
  if (!isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID) && getMainAccountToken()) {
    targets.push({ id: MAIN_CODEX_ACCOUNT_ID });
  }
  if (providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool") return targets;

  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account) || isCodexAccountPaused(config, account.id)) continue;
    const record = readCodexAccountRecord(account.id);
    if (!record?.credential || record.deletedAt != null) continue;
    targets.push({ id: account.id });
  }
  return targets;
}

async function defaultWarmAccount(accountId: string, model: string): Promise<void> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    const lease = tryAcquireNativeMainProfileClaim();
    if (!lease) throw new Error("native-main-busy");
    try {
      const token = getMainAccountToken();
      if (!token) throw new Error("native-main-missing");
      await warmCodexAccount({
        accessToken: token.accessToken,
        chatgptAccountId: token.chatgptAccountId,
        model,
        fallbackModels: [],
      });
    } finally {
      lease.release();
    }
    return;
  }

  const token = await getValidCodexToken(accountId);
  await warmCodexAccount({
    accessToken: token.accessToken,
    chatgptAccountId: token.chatgptAccountId,
    model,
    fallbackModels: [],
  });
}

/**
 * One bounded weekly-anchor sweep.
 *
 * A durable write-ahead record moves `nextDueAtMs` before the synthetic request leaves. Even if
 * the process exits after upstream accepted the request, the same account/cycle is not retried.
 */
export async function runCodexQuotaAnchorSweep(
  config: OcxConfig,
  model = "gpt-5.6-luna",
  deps: CodexQuotaAnchorDeps = {},
): Promise<CodexQuotaAnchorResult> {
  const nowMs = (deps.now ?? Date.now)();
  const loadState = deps.loadState ?? loadCodexQuotaAnchorState;
  const saveState = deps.saveState ?? saveCodexQuotaAnchorState;
  const listTargets = deps.listTargets ?? defaultTargets;
  const refreshQuota = deps.refreshQuota ?? fetchFreshCodexQuotaForAnchor;
  const warmAccount = deps.warmAccount ?? defaultWarmAccount;
  const targets = listTargets(config);
  const liveIds = new Set(targets.map(target => target.id));
  const state = loadState();
  const result: CodexQuotaAnchorResult = { anchored: [], usagePresent: [], failed: [], unknown: [] };

  for (const id of Object.keys(state.accounts)) {
    if (!liveIds.has(id)) delete state.accounts[id];
  }

  for (const target of targets) {
    const previous = state.accounts[target.id];
    if (previous && nowMs < previous.nextDueAtMs) continue;

    let quota: Omit<StoredAccountQuota, "updatedAt"> | null;
    try {
      quota = await refreshQuota(config, target.id);
    } catch {
      quota = null;
    }
    const percent = quota?.weeklyPercent;
    const resetAtMs = unixResetAtMs(quota?.weeklyResetAt);
    if (typeof percent !== "number" || !Number.isFinite(percent) || resetAtMs === null) {
      result.unknown.push(target.id);
      continue;
    }

    if (percent > 0) {
      state.accounts[target.id] = {
        nextDueAtMs: nextDue(resetAtMs, nowMs),
        lastCheckedAtMs: nowMs,
        status: "usage-present",
      };
      saveState(state);
      result.usagePresent.push(target.id);
      continue;
    }
    if (percent !== 0) {
      result.unknown.push(target.id);
      continue;
    }

    // Move the due date before the request. A crash cannot turn one accepted request into two.
    state.accounts[target.id] = {
      nextDueAtMs: nextDue(resetAtMs, nowMs),
      lastCheckedAtMs: nowMs,
      lastAttemptedAtMs: nowMs,
      status: "attempting",
    };
    try {
      saveState(state);
    } catch {
      if (previous) state.accounts[target.id] = previous;
      else delete state.accounts[target.id];
      result.failed.push(target.id);
      continue;
    }

    try {
      await warmAccount(target.id, model);
      state.accounts[target.id] = {
        ...state.accounts[target.id]!,
        status: "anchored",
      };
      result.anchored.push(target.id);
    } catch (error) {
      state.accounts[target.id] = {
        ...state.accounts[target.id]!,
        status: "failed",
        lastFailureCode: safeFailureCode(error),
      };
      result.failed.push(target.id);
    }
    try {
      saveState(state);
    } catch {
      // The write-ahead state already suppresses this cycle; final status is best-effort only.
    }
  }

  try {
    saveState(state);
  } catch {
    // No request is authorized by this final housekeeping write.
  }
  return result;
}
