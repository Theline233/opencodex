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
  const namespaces = accountIdByNamespace(config);
  const mutable = new Map<string, MutableAccountUsage>();
  for (const accountId of refs.values()) mutable.set(accountId, blankUsage());
  const since = now - CODEX_ACCOUNT_USAGE_WINDOW_MS;

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
      if (!accountId || !mutable.has(accountId)) continue;
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
