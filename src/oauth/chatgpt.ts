import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";
import { generatePKCE } from "./pkce";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const ORIGINATOR = "opencodex";

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function extractAccountId(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
    const ns = payload["https://api.openai.com/auth"];
    if (ns && typeof ns === "object" && typeof (ns as Record<string, unknown>).chatgpt_account_id === "string") {
      return (ns as Record<string, unknown>).chatgpt_account_id as string;
    }
    const orgs = payload.organizations;
    if (Array.isArray(orgs) && orgs[0] && typeof orgs[0].id === "string") return orgs[0].id as string;
  }
  return undefined;
}

export function extractEmail(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.email === "string") return payload.email.toLowerCase();
  }
  return undefined;
}

export interface ChatGPTSubscriptionClaims {
  plan?: string;
  activeUntil?: string;
}

function normalizedJwtScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the ChatGPT organization/workspace id carried by Codex OAuth JWTs.
 *
 * One ChatGPT identity can expose more than one organization. Keep this
 * separate from `extractAccountId`: account-check responses are keyed by the
 * organization in some deployments, while the account id remains the right
 * fallback for request headers and legacy payloads.
 */
export function extractChatGPTOrganizationId(idToken?: string, accessToken?: string): string | undefined {
  const organizationKeys = [
    "organization_id",
    "chatgpt_organization_id",
    "chatgpt_org_id",
    "org_id",
    "poid",
    "POID",
  ];
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    const auth = payload["https://api.openai.com/auth"];
    const sources = [
      isRecordLike(auth) ? auth : undefined,
      payload,
    ];
    for (const source of sources) {
      if (!source) continue;
      for (const key of organizationKeys) {
        const value = normalizedJwtScalar(source[key]);
        if (value) return value;
      }
      const organizations = source.organizations;
      if (!Array.isArray(organizations)) continue;
      const selected = organizations.find(item => isRecordLike(item) && item.is_default === true)
        ?? organizations[0];
      if (isRecordLike(selected)) {
        const value = normalizedJwtScalar(selected.id);
        if (value) return value;
      }
    }
  }
  return undefined;
}

/**
 * Extract the ChatGPT plan and subscription deadline carried by Codex OAuth JWTs.
 *
 * `activeUntil` intentionally remains a normalized scalar here. The subscription
 * store owns timestamp validation/canonicalization, while this OAuth helper stays
 * limited to claim lookup and never confuses the value with the JWT `exp` claim.
 */
export function extractChatGPTSubscriptionClaims(
  idToken?: string,
  accessToken?: string,
): ChatGPTSubscriptionClaims | undefined {
  let plan: string | undefined;
  let activeUntil: string | undefined;
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    const auth = payload?.["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) continue;
    const claims = auth as Record<string, unknown>;
    plan ??= normalizedJwtScalar(claims.chatgpt_plan_type);
    activeUntil ??= normalizedJwtScalar(claims.chatgpt_subscription_active_until);
    if (plan && activeUntil) break;
  }
  return plan || activeUntil ? { ...(plan ? { plan } : {}), ...(activeUntil ? { activeUntil } : {}) } : undefined;
}

function credsFromToken(data: Record<string, unknown>): OAuthCredentials {
  const idToken = typeof data.id_token === "string" ? data.id_token : undefined;
  const accessToken = data.access_token as string;
  // ?? only guards null/undefined; NaN or a string expires_in would otherwise
  // produce a NaN expiry that never compares as expired, and a negative duration
  // would stamp an already-past expiry — both block refresh semantics.
  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in >= 0
      ? data.expires_in
      : 3600;
  // The computed timestamp itself must stay finite: Number.MAX_VALUE passes
  // Number.isFinite but overflows to Infinity once multiplied by 1000.
  const computedExpires = Date.now() + expiresIn * 1000;
  const expires = Number.isFinite(computedExpires) ? computedExpires : Date.now() + 3600 * 1000;
  return {
    access: accessToken,
    refresh: (data.refresh_token as string) ?? "",
    expires,
    accountId: extractAccountId(idToken, accessToken),
    email: extractEmail(idToken, accessToken),
  };
}

export class ChatGPTOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";
  forceLogin = false;

  constructor(ctrl: OAuthController) {
    super(ctrl, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      callbackHostname: "localhost",
      callbackBindHostname: "127.0.0.1",
      redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
    });
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      codex_cli_simplified_flow: "true",
      originator: ORIGINATOR,
    });
    params.set("id_token_add_organizations", "true");
    if (this.forceLogin) params.set("prompt", "login");
    return {
      url: `${AUTH_URL}?${params}`,
      instructions: "Complete ChatGPT login in your browser.",
    };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    if (!this.#verifier) throw new Error("ChatGPT PKCE verifier not initialized");
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: this.#verifier,
      }).toString(),
    });
    if (!resp.ok) {
      const errDesc = await safeErrorDescription(resp);
      throw new Error(`ChatGPT token exchange failed: ${resp.status} ${errDesc}`);
    }
    return credsFromToken((await resp.json()) as Record<string, unknown>);
  }
}

function safeErrorDescription(resp: Response): Promise<string> {
  return resp.text().catch(() => "").then(text => {
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      return [parsed.error, parsed.error_description].filter(Boolean).join(": ") || `HTTP ${resp.status}`;
    } catch { return `HTTP ${resp.status}`; }
  });
}

export async function loginChatGPT(ctrl: OAuthController, opts?: { forceLogin?: boolean }): Promise<OAuthCredentials> {
  const flow = new ChatGPTOAuthFlow(ctrl);
  if (opts?.forceLogin) flow.forceLogin = true;
  return flow.login();
}

// Note: uses form-urlencoded per OAuth 2.0 spec (RFC 6749 §6).
// Codex-rs uses JSON for refresh — intentional divergence; both accepted by auth.openai.com.
export async function refreshChatGPTToken(refreshToken: string): Promise<OAuthCredentials> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!resp.ok) {
    const errDesc = await safeErrorDescription(resp);
    throw new Error(`ChatGPT refresh failed: ${resp.status} ${errDesc}`);
  }
  return credsFromToken((await resp.json()) as Record<string, unknown>);
}
