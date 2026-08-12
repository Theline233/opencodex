import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearCodexSubscription,
  getCodexSubscriptionDto,
  normalizeCodexSubscriptionActiveUntil,
  observeCodexSubscriptionFromJwt,
  parseCodexSubscriptionAccountCheck,
  parseCodexSubscriptionsResponse,
  refreshCodexSubscription,
} from "../src/codex/subscription";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-subscription-test");
let previousHome: string | undefined;

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearCodexSubscription();
});

afterEach(() => {
  clearCodexSubscription();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Codex subscription metadata", () => {
  test("normalizes epoch seconds, epoch milliseconds, and ISO timestamps", () => {
    expect(normalizeCodexSubscriptionActiveUntil(1767225600)).toBe("2026-01-01T00:00:00.000Z");
    expect(normalizeCodexSubscriptionActiveUntil("1767225600000")).toBe("2026-01-01T00:00:00.000Z");
    expect(normalizeCodexSubscriptionActiveUntil("2026-01-01T08:00:00+08:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(normalizeCodexSubscriptionActiveUntil("not-a-date")).toBeUndefined();
  });

  test("observes a subscription from JWT without persisting tokens", () => {
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_subscription_active_until: 1798761600,
      },
    });
    const subscription = observeCodexSubscriptionFromJwt({
      accountId: "pool-jwt",
      accessToken,
      credentialGeneration: 7,
      now: 1_700_000_000_000,
    });
    expect(subscription).toMatchObject({
      plan: "plus",
      activeUntil: "2027-01-01T00:00:00.000Z",
      source: "jwt",
      observedAt: 1_700_000_000_000,
    });
    expect(JSON.stringify(subscription)).not.toContain(accessToken);
  });

  test("drops a previous generation snapshot even when the replacement JWT has no subscription claim", () => {
    observeCodexSubscriptionFromJwt({
      accountId: "pool-replaced",
      accessToken: fakeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-old",
          chatgpt_plan_type: "plus",
          chatgpt_subscription_active_until: 1_798_761_600,
        },
      }),
      credentialGeneration: 1,
      now: 1_700_000_000_000,
    });
    expect(observeCodexSubscriptionFromJwt({
      accountId: "pool-replaced",
      accessToken: fakeJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-new" },
      }),
      credentialGeneration: 2,
      now: 1_700_000_001_000,
    })).toBeNull();
    expect(getCodexSubscriptionDto("pool-replaced")).toBeNull();
  });

  test("keeps subscription metadata across token refresh for the same physical identity", () => {
    const first = observeCodexSubscriptionFromJwt({
      accountId: "pool-token-refresh",
      accessToken: fakeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-stable",
          chatgpt_plan_type: "plus",
          chatgpt_subscription_active_until: 1_798_761_600,
        },
      }),
      credentialGeneration: 4,
      now: 1_700_000_000_000,
    });
    const refreshed = observeCodexSubscriptionFromJwt({
      accountId: "pool-token-refresh",
      accessToken: fakeJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-stable" },
      }),
      credentialGeneration: 5,
      now: 1_700_000_001_000,
    });
    expect(refreshed?.activeUntil).toBe(first?.activeUntil);
  });

  test("clearing one account hydrates disk first and preserves other cached accounts", async () => {
    clearCodexSubscription();
    writeFileSync(join(TEST_DIR, "codex-subscription-cache.json"), `${JSON.stringify({
      version: 1,
      subscriptions: {
        removed: { activeUntil: "2027-01-01T00:00:00.000Z", observedAt: 1_700_000_000_000 },
        kept: { activeUntil: "2028-01-01T00:00:00.000Z", observedAt: 1_700_000_000_000 },
      },
    })}\n`);

    clearCodexSubscription("removed");
    expect(getCodexSubscriptionDto("removed")).toBeNull();
    expect(getCodexSubscriptionDto("kept")?.activeUntil).toBe("2028-01-01T00:00:00.000Z");
  });

  test("selects a preferred account and parses entitlement expiry", () => {
    const parsed = parseCodexSubscriptionAccountCheck({
      accounts: {
        free: { account: { id: "acct-free", plan_type: "free" }, entitlement: { expires_at: null } },
        paid: {
          account: { id: "acct-paid", plan_type: "plus" },
          entitlement: { subscription_plan: "plus", expires_at: 1798761600 },
        },
      },
    }, "acct-paid");
    expect(parsed).toEqual({
      accountId: "acct-paid",
      plan: "plus",
      activeUntil: "2027-01-01T00:00:00.000Z",
    });
  });

  test("prefers the JWT organization key before the account id", () => {
    const parsed = parseCodexSubscriptionAccountCheck({
      accounts: {
        "org-secondary": {
          account: { id: "acct-shared", plan_type: "plus" },
          entitlement: { expires_at: 1_800_000_000 },
        },
        "org-default": {
          account: { id: "acct-shared", plan_type: "plus" },
          entitlement: { expires_at: 1_810_000_000 },
        },
      },
    }, "acct-shared", "org-default");
    expect(parsed?.activeUntil).toBe("2027-05-11T01:46:40.000Z");
  });

  test("matches an organization id carried inside the account record", () => {
    const parsed = parseCodexSubscriptionAccountCheck({
      accounts: [
        { account: { id: "acct-shared", organization_id: "org-secondary", plan_type: "plus" }, entitlement: { expires_at: 1_800_000_000 } },
        { account: { id: "acct-shared", organization_id: "org-default", plan_type: "plus" }, entitlement: { expires_at: 1_810_000_000 } },
      ],
    }, "acct-shared", "org-default");
    expect(parsed?.activeUntil).toBe("2027-05-11T01:46:40.000Z");
  });

  test("parses subscriptions fallback payload", () => {
    expect(parseCodexSubscriptionsResponse({
      subscription_plan: "plus",
      active_until: "2027-01-01T00:00:00Z",
    })).toEqual({ plan: "plus", activeUntil: "2027-01-01T00:00:00.000Z" });
  });

  test("falls back from accounts-check to subscriptions and sends browser target headers", async () => {
    const calls: Array<{ url: URL; headers: Headers }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      if (calls.length === 1) {
        return Response.json({ accounts: [{ account: { id: "acct-paid", plan_type: "plus" } }] });
      }
      return Response.json({ subscription_plan: "plus", active_until: 1798761600 });
    }) as typeof fetch;

    const result = await refreshCodexSubscription({
      accountId: "pool-refresh",
      accessToken: "fake-access-token",
      chatgptAccountId: "acct-paid",
      credentialGeneration: 3,
      force: true,
      now: 1_700_000_000_000,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      attempted: true,
      subscription: {
        plan: "plus",
        activeUntil: "2027-01-01T00:00:00.000Z",
        source: "subscriptions",
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe("/backend-api/accounts/check/v4-2023-04-27");
    expect(calls[1]!.url.searchParams.get("account_id")).toBe("acct-paid");
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer fake-access-token");
    expect(calls[0]!.headers.get("x-openai-target-path")).toBe("/backend-api/accounts/check/v4-2023-04-27");
  });

  test("falls back to subscriptions when accounts-check returns an expired deadline", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? Response.json({
          accounts: [{
            account: { id: "acct-expired", plan_type: "plus" },
            entitlement: { expires_at: 1_600_000_000 },
          }],
        })
        : Response.json({ subscription_plan: "plus", active_until: 1_900_000_000 });
    }) as typeof fetch;

    const result = await refreshCodexSubscription({
      accountId: "pool-expired-fallback",
      accessToken: "fake-access-token",
      chatgptAccountId: "acct-expired",
      now: 1_700_000_000_000,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      subscription: { source: "subscriptions", activeUntil: "2030-03-17T17:46:40.000Z" },
    });
    expect(calls).toBe(2);
  });

  test("automatic refresh reuses a future deadline without another upstream request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({
        accounts: [{
          account: { id: "acct-cached", plan_type: "plus" },
          entitlement: { expires_at: 1_900_000_000 },
        }],
      });
    }) as typeof fetch;
    const options = {
      accountId: "pool-cached",
      accessToken: "fake-access-token",
      chatgptAccountId: "acct-cached",
      now: 1_700_000_000_000,
      fetchImpl,
    };

    const first = await refreshCodexSubscription(options);
    const second = await refreshCodexSubscription({ ...options, now: 1_700_000_001_000 });

    expect(first).toMatchObject({ ok: true, attempted: true });
    expect(second).toMatchObject({ ok: true, attempted: false });
    expect(calls).toBe(1);
  });

  test("coalesces concurrent refreshes for the same pool slot", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = (async () => {
      calls += 1;
      await gate;
      return Response.json({
        accounts: [{
          account: { id: "acct-flight", plan_type: "plus" },
          entitlement: { expires_at: 1_900_000_000 },
        }],
      });
    }) as typeof fetch;
    const options = {
      accountId: "pool-flight",
      accessToken: "fake-access-token",
      chatgptAccountId: "acct-flight",
      force: true,
      fetchImpl,
    };

    const first = refreshCodexSubscription(options);
    const second = refreshCodexSubscription(options);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(calls).toBe(1);
  });

  test("does not coalesce concurrent refreshes for different physical identities in one slot", async () => {
    const requestedAccountIds: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id") ?? "missing";
      requestedAccountIds.push(accountId);
      return Response.json({
        accounts: [{
          account: { id: accountId, plan_type: "plus" },
          entitlement: { expires_at: 1_900_000_000 },
        }],
      });
    }) as typeof fetch;

    await Promise.all([
      refreshCodexSubscription({
        accountId: "pool-reused-slot",
        accessToken: "first-token",
        chatgptAccountId: "acct-first",
        credentialGeneration: 1,
        force: true,
        fetchImpl,
      }),
      refreshCodexSubscription({
        accountId: "pool-reused-slot",
        accessToken: "second-token",
        chatgptAccountId: "acct-second",
        credentialGeneration: 1,
        force: true,
        fetchImpl,
      }),
    ]);

    expect(requestedAccountIds.toSorted()).toEqual(["acct-first", "acct-second"]);
  });

  test("does not let a cleared account be resurrected by an older in-flight refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = (async () => {
      await gate;
      return Response.json({
        accounts: [{
          account: { id: "acct-deleted", plan_type: "plus" },
          entitlement: { expires_at: 1_900_000_000 },
        }],
      });
    }) as typeof fetch;

    const pending = refreshCodexSubscription({
      accountId: "pool-deleted",
      accessToken: "fake-access-token",
      chatgptAccountId: "acct-deleted",
      credentialGeneration: 1,
      force: true,
      fetchImpl,
    });
    clearCodexSubscription("pool-deleted");
    release();

    expect(await pending).toMatchObject({ ok: true, attempted: true, subscription: null });
    expect(getCodexSubscriptionDto("pool-deleted")).toBeNull();
  });

  test("does not let an automatic retry absorb a force refresh", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) await gate;
      return Response.json({
        accounts: [{
          account: { id: "acct-force", plan_type: "plus" },
          entitlement: { expires_at: 1_900_000_000 },
        }],
      });
    }) as typeof fetch;
    const base = {
      accountId: "pool-force",
      accessToken: "fake-access-token",
      chatgptAccountId: "acct-force",
      credentialGeneration: 1,
      fetchImpl,
    };

    const automatic = refreshCodexSubscription(base);
    const forced = refreshCodexSubscription({ ...base, force: true });
    release();
    await Promise.all([automatic, forced]);

    expect(calls).toBe(2);
  });

  test("derives organization matching from the access token when the caller omits it", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { organization_id: "org-token" },
    })).toString("base64url");
    const accessToken = `${header}.${payload}.fakesig`;
    let selectedExpiry: number | undefined;
    const fetchImpl = (async () => Response.json({
      accounts: {
        "org-other": { account: { id: "acct-shared", plan_type: "plus" }, entitlement: { expires_at: 1_700_000_000 } },
        "org-token": { account: { id: "acct-shared", plan_type: "plus" }, entitlement: { expires_at: 1_810_000_000 } },
      },
    })) as typeof fetch;
    const result = await refreshCodexSubscription({
      accountId: "pool-org-token",
      accessToken,
      chatgptAccountId: "acct-shared",
      force: true,
      fetchImpl,
    });
    selectedExpiry = result.subscription?.activeUntil ? Date.parse(result.subscription.activeUntil) / 1000 : undefined;
    expect(selectedExpiry).toBe(1_810_000_000);
  });

  test("stores only a sanitized error code and enforces retry backoff", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("secret upstream diagnostic", { status: 500 });
    }) as typeof fetch;
    const first = await refreshCodexSubscription({
      accountId: "pool-error",
      accessToken: "sensitive-token",
      force: false,
      now: 1_700_000_000_000,
      fetchImpl,
    });
    expect(first).toMatchObject({ ok: false, attempted: true, errorCode: "upstream_error" });
    expect(JSON.stringify(getCodexSubscriptionDto("pool-error"))).not.toContain("secret upstream diagnostic");
    expect(JSON.stringify(getCodexSubscriptionDto("pool-error"))).not.toContain("sensitive-token");

    const second = await refreshCodexSubscription({
      accountId: "pool-error",
      accessToken: "sensitive-token",
      force: false,
      now: 1_700_000_001_000,
      fetchImpl,
    });
    expect(second).toMatchObject({ ok: false, attempted: false, errorCode: "upstream_error" });
    expect(calls).toBe(1);
  });
});
