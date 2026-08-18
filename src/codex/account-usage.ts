import { CODEX_ACCOUNT_LOG_LABEL_RE, codexAccountLogLabel } from "./account-label";
import { isSelectableCodexPoolAccount, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { codexAccountNamespaceEntries } from "./account-namespaces";
import { baseProviderLabel } from "../providers/label";
import { estimateRequestCost, serviceTierContext } from "../usage/cost";
import type { CodexUsageAccountLogLabel, PersistedUsageAttempt, PersistedUsageEntry } from "../usage/log";
import type { OcxConfig } from "../types";

export const CODEX_ACCOUNT_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface CodexAccountUsage7d {
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export type CodexWeeklyCapacityConfidence = "collecting" | "low" | "medium" | "high";

export interface CodexAccountWeeklyCapacityEstimate {
  cycleStartAt: number;
  resetAt: number;
  usedPercent: number;
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
  totalTokens: number;
  observedCostUsd: number;
  priceCoverageRatio: number;
  estimatedTotalCostUsd?: number;
  estimatedRemainingCostUsd?: number;
  confidence: CodexWeeklyCapacityConfidence;
}

export type CodexWeeklyQuotaSnapshot = {
  weeklyPercent?: number;
  weeklyResetAt?: number;
};

type MutableAccountUsage = CodexAccountUsage7d & {
  pricedRequestIds: Set<string>;
  unpricedRequestIds: Set<string>;
  unmeteredRequestIds: Set<string>;
};

export interface CodexAccountUsageSnapshot {
  byAccountId: Map<string, CodexAccountUsage7d>;
  since: number;
  generatedAt: number;
}

export interface CodexAccountWeeklyCapacitySnapshot {
  byAccountId: Map<string, CodexAccountWeeklyCapacityEstimate>;
  generatedAt: number;
}

type Attribution = Pick<PersistedUsageAttempt, "provider" | "model" | "usageStatus" | "usage" | "totalTokens" | "accountLogLabel">;

export type CodexAccountUsageIdentity = Pick<OcxConfig, "codexAccounts" | "codexAccountNamespaces"> & {
  /** Whether the canonical OpenAI forward provider currently rotates server accounts. */
  codexAccountMode?: "pool" | "direct";
};

function blankUsage(): MutableAccountUsage {
  return {
    requests: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    unmeteredRequests: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    pricedRequestIds: new Set(),
    unpricedRequestIds: new Set(),
    unmeteredRequestIds: new Set(),
  };
}

function accountIdByRef(config: Pick<CodexAccountUsageIdentity, "codexAccounts">): Map<CodexUsageAccountLogLabel, string> {
  const map = new Map<CodexUsageAccountLogLabel, string>([["main", MAIN_CODEX_ACCOUNT_ID]]);
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    map.set(codexAccountLogLabel(account) as CodexUsageAccountLogLabel, account.id);
  }
  return map;
}

function rollupCodexAccountUsageWindow(
  entries: readonly PersistedUsageEntry[],
  config: CodexAccountUsageIdentity,
  sinceByAccountId: ReadonlyMap<string, number>,
  now: number,
): CodexAccountUsageSnapshot {
  const refs = accountIdByRef(config);
  const namespaces = accountIdByNamespace(config);
  const mutable = new Map<string, MutableAccountUsage>();
  for (const accountId of sinceByAccountId.keys()) mutable.set(accountId, blankUsage());
  const since = sinceByAccountId.size > 0 ? Math.min(...sinceByAccountId.values()) : now;

  for (const entry of entries) {
    if (!Number.isFinite(entry.timestamp) || entry.timestamp < since || entry.timestamp > now) continue;
    const seenRequestAccounts = new Set<string>();
    for (const attribution of entryAttributions(entry)) {
      const accountId = attribution.accountLogLabel === undefined
        && config.codexAccountMode === "direct"
        && baseProviderLabel(attribution.provider) === "openai"
        && legacyProviderAccountId(attribution.provider, refs, namespaces) === undefined
        ? undefined
        : attributedAccountId(attribution, refs, namespaces);
      if (!accountId || !mutable.has(accountId) || entry.timestamp < sinceByAccountId.get(accountId)!) continue;
      const bucket = mutable.get(accountId)!;
      if (!seenRequestAccounts.has(accountId)) {
        bucket.requests += 1;
        seenRequestAccounts.add(accountId);
      }
      bucket.totalTokens += displayTokens(attribution);
      if (attribution.usageStatus === "unreported" || attribution.usageStatus === "unsupported" || !attribution.usage) {
        bucket.unmeteredRequestIds.add(entry.requestId);
        continue;
      }
      const estimate = estimateRequestCost({
        provider: attribution.provider,
        model: attribution.model,
        usage: attribution.usage,
        usageStatus: attribution.usageStatus,
        serviceTier: serviceTierContext(entry),
      });
      if (!estimate) {
        bucket.unpricedRequestIds.add(entry.requestId);
        continue;
      }
      bucket.pricedRequestIds.add(entry.requestId);
      bucket.estimatedCostUsd += estimate.cost.total;
    }
  }
  const byAccountId = new Map<string, CodexAccountUsage7d>();
  for (const [accountId, bucket] of mutable) {
    byAccountId.set(accountId, {
      requests: bucket.requests,
      pricedRequests: bucket.pricedRequestIds.size,
      unpricedRequests: bucket.unpricedRequestIds.size,
      unmeteredRequests: bucket.unmeteredRequestIds.size,
      totalTokens: bucket.totalTokens,
      estimatedCostUsd: bucket.estimatedCostUsd,
    });
  }
  return { byAccountId, since, generatedAt: now };
}

function accountIdByNamespace(config: Pick<CodexAccountUsageIdentity, "codexAccountNamespaces">): Map<string, string> {
  return new Map(codexAccountNamespaceEntries(config));
}

function legacyProviderAccountId(
  provider: string,
  refs: ReadonlyMap<CodexUsageAccountLogLabel, string>,
  namespaces: ReadonlyMap<string, string>,
): string | undefined {
  const cut = provider.lastIndexOf("-");
  if (cut <= 0) return undefined;
  const suffix = provider.slice(cut + 1);
  if (suffix === "main") return MAIN_CODEX_ACCOUNT_ID;
  if (CODEX_ACCOUNT_LOG_LABEL_RE.test(suffix)) return refs.get(suffix as CodexUsageAccountLogLabel);
  // Namespace aliases may themselves contain dashes. Match the longest complete
  // suffix, and only accept it when the prefix is a canonical OpenAI forward.
  // This avoids both truncating `team-work` to `work` and accidentally claiming
  // an unrelated provider that happens to share the same suffix.
  const candidates = [...namespaces.entries()].sort(([left], [right]) => right.length - left.length);
  for (const [namespace, target] of candidates) {
    const marker = `-${namespace}`;
    if (!provider.endsWith(marker)) continue;
    const prefix = provider.slice(0, -marker.length);
    if (baseProviderLabel(prefix) !== "openai" || prefix === "openai-apikey") continue;
    return target;
  }
  return undefined;
}

function attributedAccountId(
  attribution: Attribution,
  refs: ReadonlyMap<CodexUsageAccountLogLabel, string>,
  namespaces: ReadonlyMap<string, string>,
): string | undefined {
  if (attribution.accountLogLabel) return refs.get(attribution.accountLogLabel);
  const legacy = legacyProviderAccountId(attribution.provider, refs, namespaces);
  if (legacy) return legacy;
  // Historical base OpenAI/ChatGPT forward rows are usually the main Codex App login.
  // Keep the API-key provider separate: it is real platform billing, not Plus usage.
  // In today's Direct mode they could instead be caller-owned bearer traffic, so
  // fail closed rather than attach an ambiguous legacy row to the server main account.
  const base = baseProviderLabel(attribution.provider);
  return base === "openai" && attribution.provider !== "openai-apikey"
    ? MAIN_CODEX_ACCOUNT_ID
    : undefined;
}

function entryAttributions(entry: PersistedUsageEntry): Attribution[] {
  if (entry.attempts?.length) {
    return entry.attempts.map(attempt => ({
      provider: attempt.provider,
      model: attempt.model,
      usageStatus: attempt.usageStatus,
      ...(attempt.usage ? { usage: attempt.usage } : {}),
      ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
      ...(attempt.accountLogLabel ? { accountLogLabel: attempt.accountLogLabel } : {}),
    }));
  }
  return [{
    provider: entry.provider,
    model: entry.model,
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    ...(entry.accountLogLabel ? { accountLogLabel: entry.accountLogLabel } : {}),
  }];
}

function displayTokens(attribution: Attribution): number {
  if (!attribution.usage) return attribution.totalTokens ?? 0;
  return Math.max(
    attribution.usage.inputTokens + attribution.usage.outputTokens,
    attribution.usage.totalTokens ?? attribution.totalTokens ?? 0,
  );
}

/**
 * Pure one-pass rollup for the account cards. Every physical request counts once
 * per account even when a combo has multiple attempts on the same account; token
 * and cost totals still sum all of those attempts.
 */
export function rollupCodexAccountUsage7d(
  entries: readonly PersistedUsageEntry[],
  config: CodexAccountUsageIdentity,
  now = Date.now(),
): CodexAccountUsageSnapshot {
  const refs = accountIdByRef(config);
  const since = now - CODEX_ACCOUNT_USAGE_WINDOW_MS;
  return rollupCodexAccountUsageWindow(
    entries,
    config,
    new Map([...refs.values()].map(accountId => [accountId, since])),
    now,
  );
}

function resetAtMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function priceCoverage(usage: CodexAccountUsage7d): number {
  const classified = usage.pricedRequests + usage.unpricedRequests + usage.unmeteredRequests;
  const denominator = Math.max(usage.requests, classified);
  if (denominator <= 0) return 0;
  // A combo request can contain both priced and unpriced attempts. Counting every
  // classification in the denominator keeps confidence conservative in that case.
  return Math.max(0, Math.min(1, usage.pricedRequests / denominator));
}

function capacityConfidence(
  usedPercent: number,
  coverage: number,
  historyTruncated: boolean,
): CodexWeeklyCapacityConfidence {
  if (usedPercent < 5) return "collecting";
  if (historyTruncated || coverage < 0.8 || usedPercent < 10) return "low";
  if (coverage >= 0.95 && usedPercent >= 50) return "high";
  return "medium";
}

/**
 * Estimate each account's current seven-day capacity in API list-price equivalent USD.
 * The upstream percentage remains authoritative; the denominator is never presented as billing.
 */
export function estimateCodexAccountWeeklyCapacities(
  entries: readonly PersistedUsageEntry[],
  config: CodexAccountUsageIdentity,
  quotaByAccountId: ReadonlyMap<string, CodexWeeklyQuotaSnapshot | null>,
  historyTruncated: boolean,
  now = Date.now(),
): CodexAccountWeeklyCapacitySnapshot {
  const cycles = new Map<string, { cycleStartAt: number; resetAt: number; usedPercent: number }>();
  for (const [accountId, quota] of quotaByAccountId) {
    const resetAt = resetAtMs(quota?.weeklyResetAt);
    const usedPercent = quota?.weeklyPercent;
    if (resetAt === null
      || resetAt <= now
      || resetAt > now + CODEX_ACCOUNT_USAGE_WINDOW_MS
      || typeof usedPercent !== "number"
      || !Number.isFinite(usedPercent)
      || usedPercent < 0
      || usedPercent > 100) continue;
    cycles.set(accountId, {
      cycleStartAt: resetAt - CODEX_ACCOUNT_USAGE_WINDOW_MS,
      resetAt,
      usedPercent,
    });
  }
  const rolled = rollupCodexAccountUsageWindow(
    entries,
    config,
    new Map([...cycles].map(([accountId, cycle]) => [accountId, cycle.cycleStartAt])),
    now,
  );
  const byAccountId = new Map<string, CodexAccountWeeklyCapacityEstimate>();
  for (const [accountId, cycle] of cycles) {
    const usage = rolled.byAccountId.get(accountId) ?? {
      requests: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
      unmeteredRequests: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    const coverage = priceCoverage(usage);
    const confidence = usage.estimatedCostUsd > 0
      ? capacityConfidence(cycle.usedPercent, coverage, historyTruncated)
      : "collecting";
    const canEstimate = confidence !== "collecting" && usage.estimatedCostUsd > 0;
    const estimatedTotalCostUsd = canEstimate
      ? usage.estimatedCostUsd / (cycle.usedPercent / 100)
      : undefined;
    byAccountId.set(accountId, {
      ...cycle,
      requests: usage.requests,
      pricedRequests: usage.pricedRequests,
      unpricedRequests: usage.unpricedRequests,
      unmeteredRequests: usage.unmeteredRequests,
      totalTokens: usage.totalTokens,
      observedCostUsd: usage.estimatedCostUsd,
      priceCoverageRatio: coverage,
      ...(estimatedTotalCostUsd !== undefined ? {
        estimatedTotalCostUsd,
        estimatedRemainingCostUsd: Math.max(0, estimatedTotalCostUsd - usage.estimatedCostUsd),
      } : {}),
      confidence,
    });
  }
  return { byAccountId, generatedAt: now };
}
