import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";
import {
  extractAccountId,
  extractChatGPTOrganizationId,
  extractChatGPTSubscriptionClaims,
} from "../oauth/chatgpt";

const SUBSCRIPTION_CACHE_FILENAME = "codex-subscription-cache.json";
const SUBSCRIPTION_PERSIST_DEBOUNCE_MS = 250;
const SUBSCRIPTION_RETRY_INTERVAL_MS = 30 * 60_000;
const SUBSCRIPTION_RESPONSE_MAX_BYTES = 256 * 1024;
const ACCOUNTS_CHECK_PATH = "/backend-api/accounts/check/v4-2023-04-27";
const ACCOUNTS_CHECK_URL = `https://chatgpt.com${ACCOUNTS_CHECK_PATH}`;
const SUBSCRIPTIONS_PATH = "/backend-api/subscriptions";
const SUBSCRIPTIONS_URL = `https://chatgpt.com${SUBSCRIPTIONS_PATH}`;

export type CodexSubscriptionSource = "jwt" | "accounts_check" | "subscriptions";
export type CodexSubscriptionErrorCode =
  | "network_error"
  | "upstream_auth"
  | "upstream_error"
  | "response_too_large"
  | "invalid_response"
  | "missing_account_id"
  | "missing_expiry";

export interface StoredCodexSubscription {
  plan?: string;
  activeUntil?: string;
  source?: CodexSubscriptionSource;
  observedAt: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  nextRetryAt?: number;
  lastErrorCode?: CodexSubscriptionErrorCode;
  identityFingerprint?: string;
  credentialGeneration?: number;
  mainIdentityGeneration?: number;
}

export interface CodexSubscriptionDto {
  plan?: string;
  activeUntil?: string;
  source?: CodexSubscriptionSource;
  observedAt: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  nextRetryAt?: number;
  lastErrorCode?: CodexSubscriptionErrorCode;
}

interface SubscriptionDiskFile {
  version: 1;
  subscriptions: Record<string, StoredCodexSubscription>;
}

interface SubscriptionSnapshot {
  plan?: string;
  activeUntil?: string;
  source: Exclude<CodexSubscriptionSource, "jwt">;
  accountId?: string;
}

interface AccountCheckRecord {
  key?: string;
  node: Record<string, unknown>;
}

export interface RefreshCodexSubscriptionOptions {
  accountId: string;
  accessToken: string;
  chatgptAccountId?: string;
  organizationId?: string;
  credentialGeneration?: number;
  mainIdentityGeneration?: number;
  force?: boolean;
  now?: number;
  fetchImpl?: typeof fetch;
  isCurrent?: () => boolean;
}

export type RefreshCodexSubscriptionResult =
  | { ok: true; attempted: boolean; subscription: CodexSubscriptionDto | null }
  | { ok: false; attempted: boolean; errorCode: CodexSubscriptionErrorCode; subscription: CodexSubscriptionDto | null };

class SubscriptionRefreshError extends Error {
  constructor(readonly code: CodexSubscriptionErrorCode) {
    super(code);
    this.name = "SubscriptionRefreshError";
  }
}

const accountSubscriptions = new Map<string, StoredCodexSubscription>();
const subscriptionRefreshInFlight = new Map<string, Promise<RefreshCodexSubscriptionResult>>();
const subscriptionAccountEpochs = new Map<string, number>();
let diskHydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastReconciledGeneration = 0;
let liveAccountIds = new Set<string>();
let subscriptionHome = "";
let subscriptionEpoch = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function normalizeCodexSubscriptionActiveUntil(value: unknown): string | undefined {
  const raw = normalizeScalar(value);
  if (!raw) return undefined;
  const numeric = Number(raw);
  let timestampMs: number;
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(raw)) {
    timestampMs = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  } else {
    timestampMs = Date.parse(raw);
  }
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return undefined;
  try {
    return new Date(timestampMs).toISOString();
  } catch {
    return undefined;
  }
}

function isStoredSubscription(value: unknown): value is StoredCodexSubscription {
  if (!isRecord(value) || typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt)) return false;
  if (value.plan !== undefined && typeof value.plan !== "string") return false;
  if (value.activeUntil !== undefined && normalizeCodexSubscriptionActiveUntil(value.activeUntil) === undefined) return false;
  if (value.source !== undefined && value.source !== "jwt" && value.source !== "accounts_check" && value.source !== "subscriptions") return false;
  for (const key of ["lastAttemptAt", "lastSuccessAt", "nextRetryAt", "credentialGeneration", "mainIdentityGeneration"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) return false;
  }
  if (value.lastErrorCode !== undefined && ![
    "network_error", "upstream_auth", "upstream_error", "response_too_large",
    "invalid_response", "missing_account_id", "missing_expiry",
  ].includes(String(value.lastErrorCode))) return false;
  if (value.identityFingerprint !== undefined
    && (typeof value.identityFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.identityFingerprint))) return false;
  return true;
}

function hydrateSubscriptionsFromDisk(): void {
  const currentHome = getConfigDir();
  if (subscriptionHome !== currentHome) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    subscriptionEpoch += 1;
    accountSubscriptions.clear();
    subscriptionRefreshInFlight.clear();
    subscriptionAccountEpochs.clear();
    diskHydrated = false;
    lastReconciledGeneration = 0;
    liveAccountIds = new Set();
    subscriptionHome = currentHome;
  }
  if (diskHydrated) return;
  diskHydrated = true;
  try {
    const path = join(currentHome, SUBSCRIPTION_CACHE_FILENAME);
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SubscriptionDiskFile;
    if (!parsed || parsed.version !== 1 || !isRecord(parsed.subscriptions)) return;
    for (const [accountId, raw] of Object.entries(parsed.subscriptions)) {
      if (!isStoredSubscription(raw)) continue;
      const normalized = {
        ...raw,
        ...(raw.activeUntil ? { activeUntil: normalizeCodexSubscriptionActiveUntil(raw.activeUntil) } : {}),
      } as StoredCodexSubscription;
      if (!accountSubscriptions.has(accountId)) accountSubscriptions.set(accountId, normalized);
    }
  } catch {
    // Derived metadata is optional. A corrupt cache must never block routing or the dashboard.
  }
}

function schedulePersistSubscriptions(): void {
  if (persistTimer) clearTimeout(persistTimer);
  const scheduledEpoch = subscriptionEpoch;
  persistTimer = setTimeout(() => {
    if (scheduledEpoch !== subscriptionEpoch) return;
    persistTimer = null;
    try {
      const subscriptions: Record<string, StoredCodexSubscription> = {};
      for (const [accountId, subscription] of accountSubscriptions) subscriptions[accountId] = subscription;
      const body: SubscriptionDiskFile = { version: 1, subscriptions };
      atomicWriteFile(join(getConfigDir(), SUBSCRIPTION_CACHE_FILENAME), `${JSON.stringify(body)}\n`);
    } catch {
      // Best-effort persistence only; the in-memory snapshot remains usable.
    }
  }, SUBSCRIPTION_PERSIST_DEBOUNCE_MS);
}

function mayCommitSubscription(accountId: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountIds.has(accountId);
}

function subscriptionMatchesIdentity(
  stored: StoredCodexSubscription | undefined,
  options: Pick<RefreshCodexSubscriptionOptions, "credentialGeneration" | "mainIdentityGeneration">,
  identityFingerprint?: string,
): boolean {
  if (!stored) return false;
  if (identityFingerprint && stored.identityFingerprint) {
    return stored.identityFingerprint === identityFingerprint;
  }
  if (options.credentialGeneration !== undefined) {
    return stored.credentialGeneration === options.credentialGeneration;
  }
  if (options.mainIdentityGeneration !== undefined) {
    return stored.mainIdentityGeneration === options.mainIdentityGeneration;
  }
  return true;
}

function subscriptionIdentityFingerprint(options: {
  accessToken?: string;
  idToken?: string;
  chatgptAccountId?: string;
  organizationId?: string;
}): string | undefined {
  const accountId = extractAccountId(options.idToken, options.accessToken)
    ?? normalizeScalar(options.chatgptAccountId);
  const organizationId = normalizeScalar(options.organizationId)
    ?? extractChatGPTOrganizationId(options.idToken, options.accessToken);
  if (!accountId && !organizationId) return undefined;
  return createHash("sha256")
    .update("opencodex-codex-subscription-identity\0")
    .update(accountId ?? "")
    .update("\0")
    .update(organizationId ?? "")
    .digest("hex");
}

function subscriptionRefreshFlightKey(options: RefreshCodexSubscriptionOptions): string {
  const identity = subscriptionIdentityFingerprint(options) ?? "unknown";
  const generation = options.credentialGeneration !== undefined
    ? `credential:${options.credentialGeneration}`
    : options.mainIdentityGeneration !== undefined
      ? `main:${options.mainIdentityGeneration}`
      : "generation:unknown";
  return `${options.accountId}\0${identity}\0${generation}\0${options.force ? "force" : "automatic"}`;
}

function subscriptionAccountEpoch(accountId: string): number {
  return subscriptionAccountEpochs.get(accountId) ?? 0;
}

function toDto(stored: StoredCodexSubscription | null): CodexSubscriptionDto | null {
  if (!stored) return null;
  return {
    ...(stored.plan ? { plan: stored.plan } : {}),
    ...(stored.activeUntil ? { activeUntil: stored.activeUntil } : {}),
    ...(stored.source ? { source: stored.source } : {}),
    observedAt: stored.observedAt,
    ...(stored.lastAttemptAt !== undefined ? { lastAttemptAt: stored.lastAttemptAt } : {}),
    ...(stored.lastSuccessAt !== undefined ? { lastSuccessAt: stored.lastSuccessAt } : {}),
    ...(stored.nextRetryAt !== undefined ? { nextRetryAt: stored.nextRetryAt } : {}),
    ...(stored.lastErrorCode ? { lastErrorCode: stored.lastErrorCode } : {}),
  };
}

function hasFutureSubscriptionExpiry(
  subscription: StoredCodexSubscription | null,
  now: number,
): boolean {
  if (!subscription?.activeUntil) return false;
  const expiresAt = Date.parse(subscription.activeUntil);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function getCodexSubscription(accountId: string): StoredCodexSubscription | null {
  hydrateSubscriptionsFromDisk();
  return accountSubscriptions.get(accountId) ?? null;
}

export function getCodexSubscriptionDto(accountId: string): CodexSubscriptionDto | null {
  return toDto(getCodexSubscription(accountId));
}

export function observeCodexSubscriptionFromJwt(options: {
  accountId: string;
  accessToken?: string;
  idToken?: string;
  chatgptAccountId?: string;
  organizationId?: string;
  credentialGeneration?: number;
  mainIdentityGeneration?: number;
  now?: number;
  writerGeneration?: number;
  isCurrent?: () => boolean;
}): CodexSubscriptionDto | null {
  hydrateSubscriptionsFromDisk();
  const existing = accountSubscriptions.get(options.accountId);
  const identityFingerprint = subscriptionIdentityFingerprint(options);
  const hasIdentityGeneration = options.credentialGeneration !== undefined || options.mainIdentityGeneration !== undefined;
  const hasIdentityEvidence = identityFingerprint !== undefined || hasIdentityGeneration;
  const identityChanged = hasIdentityEvidence
    && existing !== undefined
    && !subscriptionMatchesIdentity(existing, options, identityFingerprint);
  const writerGeneration = options.writerGeneration ?? captureConfigGeneration();
  if (identityChanged) {
    // Never project the previous physical account into a response after this caller has
    // already lost its credential-generation lease.
    if (options.isCurrent && !options.isCurrent()) return null;
    if (!mayCommitSubscription(options.accountId, writerGeneration)) return null;
    accountSubscriptions.delete(options.accountId);
    schedulePersistSubscriptions();
  }
  const claims = extractChatGPTSubscriptionClaims(options.idToken, options.accessToken);
  if (!claims) return getCodexSubscriptionDto(options.accountId);
  const activeUntil = normalizeCodexSubscriptionActiveUntil(claims.activeUntil);
  const plan = normalizeScalar(claims.plan);
  if (!activeUntil && !plan) return getCodexSubscriptionDto(options.accountId);
  if (options.isCurrent && !options.isCurrent()) return getCodexSubscriptionDto(options.accountId);
  if (!mayCommitSubscription(options.accountId, writerGeneration)) return getCodexSubscriptionDto(options.accountId);

  const current = accountSubscriptions.get(options.accountId);
  const now = options.now ?? Date.now();
  const next: StoredCodexSubscription = {
    ...(current ?? { observedAt: now }),
    ...(plan ? { plan } : {}),
    ...(activeUntil ? { activeUntil } : {}),
    source: "jwt",
    observedAt: now,
    ...(identityFingerprint ? { identityFingerprint } : {}),
    ...(options.credentialGeneration !== undefined ? { credentialGeneration: options.credentialGeneration } : {}),
    ...(options.mainIdentityGeneration !== undefined ? { mainIdentityGeneration: options.mainIdentityGeneration } : {}),
  };
  if (activeUntil && Date.parse(activeUntil) > now) {
    delete next.nextRetryAt;
    delete next.lastErrorCode;
  }
  accountSubscriptions.set(options.accountId, next);
  schedulePersistSubscriptions();
  return toDto(next);
}

export function clearCodexSubscription(accountId?: string): void {
  if (accountId) {
    const prefix = `${accountId}\0`;
    for (const key of subscriptionRefreshInFlight.keys()) {
      if (key.startsWith(prefix)) subscriptionRefreshInFlight.delete(key);
    }
    hydrateSubscriptionsFromDisk();
    subscriptionAccountEpochs.set(accountId, subscriptionAccountEpoch(accountId) + 1);
    accountSubscriptions.delete(accountId);
    schedulePersistSubscriptions();
    return;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  subscriptionEpoch += 1;
  subscriptionRefreshInFlight.clear();
  subscriptionAccountEpochs.clear();
  accountSubscriptions.clear();
  diskHydrated = false;
  lastReconciledGeneration = 0;
  liveAccountIds = new Set();
  try {
    const path = join(getConfigDir(), SUBSCRIPTION_CACHE_FILENAME);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort; memory is already cleared.
  }
  subscriptionHome = "";
}

export function reconcileCodexSubscriptionAccounts(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  hydrateSubscriptionsFromDisk();
  let removed = 0;
  for (const accountId of accountSubscriptions.keys()) {
    if (context.codexAccountIds.has(accountId)) continue;
    accountSubscriptions.delete(accountId);
    removed += 1;
  }
  liveAccountIds = new Set(context.codexAccountIds);
  lastReconciledGeneration = context.generation;
  if (removed > 0) schedulePersistSubscriptions();
  return removed;
}

function collectAccountCheckRecords(payload: unknown): AccountCheckRecord[] {
  const records: AccountCheckRecord[] = [];
  const push = (value: unknown, key?: string) => {
    if (isRecord(value)) records.push({ ...(key ? { key } : {}), node: value });
  };
  if (isRecord(payload) && payload.accounts !== undefined) {
    if (Array.isArray(payload.accounts)) payload.accounts.forEach(item => push(item));
    else if (isRecord(payload.accounts)) Object.entries(payload.accounts).forEach(([key, value]) => push(value, key));
  }
  if (records.length === 0 && Array.isArray(payload)) payload.forEach(item => push(item));
  if (records.length === 0 && isRecord(payload)) push(payload);
  return records;
}

function accountCheckParts(record: AccountCheckRecord): {
  account: Record<string, unknown>;
  entitlement?: Record<string, unknown>;
} {
  return {
    account: isRecord(record.node.account) ? record.node.account : record.node,
    ...(isRecord(record.node.entitlement) ? { entitlement: record.node.entitlement } : {}),
  };
}

function firstField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = normalizeScalar(record[key]);
    if (value) return value;
  }
  return undefined;
}

function accountCheckId(record: AccountCheckRecord): string | undefined {
  return firstField(accountCheckParts(record).account, ["account_id", "id", "chatgpt_account_id", "workspace_id"]);
}

function accountCheckOrganizationId(record: AccountCheckRecord): string | undefined {
  const { account } = accountCheckParts(record);
  return firstField(account, [
    "organization_id",
    "organizationId",
    "chatgpt_organization_id",
    "chatgpt_org_id",
    "org_id",
    "orgId",
    "poid",
    "POID",
  ]);
}

function accountCheckPlan(record: AccountCheckRecord): string | undefined {
  const { account, entitlement } = accountCheckParts(record);
  return firstField(entitlement, ["subscription_plan"]) ?? firstField(account, ["plan_type", "planType"]);
}

function accountCheckIsDefault(record: AccountCheckRecord): boolean {
  const { account } = accountCheckParts(record);
  return account.is_default === true || record.node.is_default === true;
}

export function parseCodexSubscriptionAccountCheck(
  payload: unknown,
  preferredAccountId?: string,
  preferredOrganizationId?: string,
): Omit<SubscriptionSnapshot, "source"> | null {
  const records = collectAccountCheckRecords(payload);
  if (records.length === 0) return null;
  const preferredOrganization = normalizeScalar(preferredOrganizationId);
  const preferredAccount = normalizeScalar(preferredAccountId);
  const selected = records.find(record => preferredOrganization && (
    record.key === preferredOrganization || accountCheckOrganizationId(record) === preferredOrganization
  ))
    ?? records.find(record => preferredAccount && (record.key === preferredAccount || accountCheckId(record) === preferredAccount))
    ?? records.find(record => accountCheckIsDefault(record))
    ?? records.find(record => {
      const plan = accountCheckPlan(record);
      return plan !== undefined && plan.toLowerCase() !== "free";
    })
    ?? records[0];
  if (!selected) return null;
  const { account, entitlement } = accountCheckParts(selected);
  const activeUntil = normalizeCodexSubscriptionActiveUntil(
    firstField(entitlement, ["expires_at"]) ?? firstField(account, ["expires_at"]),
  );
  return {
    ...(accountCheckId(selected) ? { accountId: accountCheckId(selected) } : {}),
    ...(accountCheckPlan(selected) ? { plan: accountCheckPlan(selected) } : {}),
    ...(activeUntil ? { activeUntil } : {}),
  };
}

export function parseCodexSubscriptionsResponse(payload: unknown): Omit<SubscriptionSnapshot, "source"> | null {
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.subscription) ? payload.subscription : payload;
  const plan = firstField(nested, ["subscription_plan", "plan_type"]);
  const activeUntil = normalizeCodexSubscriptionActiveUntil(firstField(nested, ["active_until", "expires_at"]));
  return plan || activeUntil ? { ...(plan ? { plan } : {}), ...(activeUntil ? { activeUntil } : {}) } : null;
}

function subscriptionHeaders(accessToken: string, targetPath: string, chatgptAccountId?: string): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Referer: "https://chatgpt.com/",
    "User-Agent": "Mozilla/5.0 OpenCodex subscription-status",
    "x-openai-target-path": targetPath,
    "x-openai-target-route": targetPath,
  });
  if (chatgptAccountId?.trim()) headers.set("ChatGPT-Account-Id", chatgptAccountId.trim());
  return headers;
}

async function fetchJsonSnapshot(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new SubscriptionRefreshError("network_error");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SubscriptionRefreshError(response.status === 401 || response.status === 403 ? "upstream_auth" : "upstream_error");
  }
  let body: Awaited<ReturnType<typeof readBoundedResponseBody>>;
  try {
    body = await readBoundedResponseBody(response, {
      maxBytes: SUBSCRIPTION_RESPONSE_MAX_BYTES,
      totalTimeoutMs: 8_000,
      inactivityTimeoutMs: 4_000,
      fatalUtf8: true,
    });
  } catch {
    throw new SubscriptionRefreshError("invalid_response");
  }
  if (!body.displaySafe) throw new SubscriptionRefreshError(body.oversized ? "response_too_large" : "invalid_response");
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    throw new SubscriptionRefreshError("invalid_response");
  }
}

async function querySubscriptionSnapshot(options: RefreshCodexSubscriptionOptions): Promise<SubscriptionSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const organizationId = options.organizationId ?? extractChatGPTOrganizationId(undefined, options.accessToken);
  const timezoneOffsetMin = new Date().getTimezoneOffset();
  const accountCheckUrl = new URL(ACCOUNTS_CHECK_URL);
  accountCheckUrl.searchParams.set("timezone_offset_min", String(timezoneOffsetMin));
  const accountCheckPayload = await fetchJsonSnapshot(
    fetchImpl,
    accountCheckUrl.toString(),
    subscriptionHeaders(options.accessToken, ACCOUNTS_CHECK_PATH, options.chatgptAccountId),
  );
  const accountCheck = parseCodexSubscriptionAccountCheck(
    accountCheckPayload,
    options.chatgptAccountId,
    organizationId,
  );
  if (!accountCheck) throw new SubscriptionRefreshError("invalid_response");
  const lookupNow = options.now ?? Date.now();
  const accountCheckExpiry = accountCheck.activeUntil ? Date.parse(accountCheck.activeUntil) : Number.NaN;
  if (Number.isFinite(accountCheckExpiry) && accountCheckExpiry > lookupNow) {
    return { ...accountCheck, source: "accounts_check" };
  }

  const accountId = accountCheck.accountId ?? normalizeScalar(options.chatgptAccountId);
  if (!accountId) throw new SubscriptionRefreshError("missing_account_id");
  const subscriptionsUrl = new URL(SUBSCRIPTIONS_URL);
  subscriptionsUrl.searchParams.set("account_id", accountId);
  const subscriptionsPayload = await fetchJsonSnapshot(
    fetchImpl,
    subscriptionsUrl.toString(),
    subscriptionHeaders(options.accessToken, SUBSCRIPTIONS_PATH, options.chatgptAccountId),
  );
  const subscriptions = parseCodexSubscriptionsResponse(subscriptionsPayload);
  const subscriptionsExpiry = subscriptions?.activeUntil ? Date.parse(subscriptions.activeUntil) : Number.NaN;
  if (!Number.isFinite(subscriptionsExpiry) || subscriptionsExpiry <= lookupNow) {
    throw new SubscriptionRefreshError("missing_expiry");
  }
  return {
    ...accountCheck,
    ...subscriptions,
    accountId,
    source: "subscriptions",
  };
}

export async function refreshCodexSubscription(
  options: RefreshCodexSubscriptionOptions,
): Promise<RefreshCodexSubscriptionResult> {
  const flightKey = subscriptionRefreshFlightKey(options);
  const currentFlight = subscriptionRefreshInFlight.get(flightKey);
  if (currentFlight) return currentFlight;
  const refresh = refreshCodexSubscriptionOnce(options);
  subscriptionRefreshInFlight.set(flightKey, refresh);
  try {
    return await refresh;
  } finally {
    if (subscriptionRefreshInFlight.get(flightKey) === refresh) {
      subscriptionRefreshInFlight.delete(flightKey);
    }
  }
}

async function refreshCodexSubscriptionOnce(
  options: RefreshCodexSubscriptionOptions,
): Promise<RefreshCodexSubscriptionResult> {
  hydrateSubscriptionsFromDisk();
  const refreshEpoch = subscriptionEpoch;
  const refreshAccountEpoch = subscriptionAccountEpoch(options.accountId);
  const now = options.now ?? Date.now();
  const writerGeneration = captureConfigGeneration();
  const identityFingerprint = subscriptionIdentityFingerprint(options);
  const stored = accountSubscriptions.get(options.accountId);
  const existing = subscriptionMatchesIdentity(stored, options, identityFingerprint) ? stored ?? null : null;
  const currentAtStart = !options.isCurrent || options.isCurrent();
  if (stored && existing === null
    && refreshEpoch === subscriptionEpoch
    && refreshAccountEpoch === subscriptionAccountEpoch(options.accountId)
    && currentAtStart) {
    accountSubscriptions.delete(options.accountId);
    schedulePersistSubscriptions();
  }
  if (!currentAtStart) {
    return { ok: true, attempted: false, subscription: null };
  }
  // The automatic dashboard path only fills a missing/expired deadline. A known future
  // deadline is stable until it elapses; manual refreshes opt out with force=true.
  if (!options.force && hasFutureSubscriptionExpiry(existing, now)) {
    return { ok: true, attempted: false, subscription: toDto(existing) };
  }
  if (!options.force && existing?.nextRetryAt !== undefined && existing.nextRetryAt > now) {
    return { ok: false, attempted: false, errorCode: existing.lastErrorCode ?? "upstream_error", subscription: toDto(existing) };
  }
  try {
    const snapshot = await querySubscriptionSnapshot(options);
    if (refreshEpoch !== subscriptionEpoch
      || refreshAccountEpoch !== subscriptionAccountEpoch(options.accountId)
      || (options.isCurrent && !options.isCurrent())) {
      return { ok: true, attempted: true, subscription: null };
    }
    if (!mayCommitSubscription(options.accountId, writerGeneration)) {
      return { ok: true, attempted: true, subscription: getCodexSubscriptionDto(options.accountId) };
    }
    const next: StoredCodexSubscription = {
      ...(existing ?? { observedAt: now }),
      ...(snapshot.plan ? { plan: snapshot.plan } : {}),
      activeUntil: snapshot.activeUntil,
      source: snapshot.source,
      observedAt: now,
      lastAttemptAt: now,
      lastSuccessAt: now,
      ...(identityFingerprint ? { identityFingerprint } : {}),
      ...(options.credentialGeneration !== undefined ? { credentialGeneration: options.credentialGeneration } : {}),
      ...(options.mainIdentityGeneration !== undefined ? { mainIdentityGeneration: options.mainIdentityGeneration } : {}),
    };
    delete next.nextRetryAt;
    delete next.lastErrorCode;
    accountSubscriptions.set(options.accountId, next);
    schedulePersistSubscriptions();
    return { ok: true, attempted: true, subscription: toDto(next) };
  } catch (error) {
    const code = error instanceof SubscriptionRefreshError ? error.code : "network_error";
    let published: StoredCodexSubscription | null = null;
    if (refreshEpoch === subscriptionEpoch
      && refreshAccountEpoch === subscriptionAccountEpoch(options.accountId)
      && (!options.isCurrent || options.isCurrent())) {
      if (mayCommitSubscription(options.accountId, writerGeneration)) {
        const next: StoredCodexSubscription = {
          ...(existing ?? { observedAt: now }),
          lastAttemptAt: now,
          nextRetryAt: now + SUBSCRIPTION_RETRY_INTERVAL_MS,
          lastErrorCode: code,
          ...(identityFingerprint ? { identityFingerprint } : {}),
          ...(options.credentialGeneration !== undefined ? { credentialGeneration: options.credentialGeneration } : {}),
          ...(options.mainIdentityGeneration !== undefined ? { mainIdentityGeneration: options.mainIdentityGeneration } : {}),
        };
        accountSubscriptions.set(options.accountId, next);
        schedulePersistSubscriptions();
        published = next;
      }
    }
    return {
      ok: false,
      attempted: true,
      errorCode: code,
      subscription: refreshEpoch !== subscriptionEpoch
        || refreshAccountEpoch !== subscriptionAccountEpoch(options.accountId)
        || (options.isCurrent && !options.isCurrent())
        ? null
        : toDto(published ?? accountSubscriptions.get(options.accountId) ?? null),
    };
  }
}
