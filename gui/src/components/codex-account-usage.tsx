import { formatEstimatedUsdValue } from "../intl-formatters";
import { useI18n } from "../i18n/shared";
import type { CodexAccountEntry } from "./codex-account-pool-types";

export function CodexAccountUsage7d({ account }: { account: CodexAccountEntry }) {
  const { t, locale } = useI18n();
  const usage = account.usage7d;
  if (!usage) return null;
  const unavailable = usage.unpricedRequests + usage.unmeteredRequests;
  const complete = unavailable === 0;

  return (
    <div
      className="card-sub codex-account-usage"
      title={t("codexAuth.usage7dDisclaimer")}
    >
      <span>{t("codexAuth.usage7dLabel")}</span>{" "}
      <strong className="mono">{formatEstimatedUsdValue(usage.estimatedCostUsd, locale)}</strong>{" "}
      <span className="faint">{t("codexAuth.usage7dRequests", { count: usage.requests })}</span>
      {!complete && (
        <span className="faint"> · {t("codexAuth.usage7dIncomplete", { count: unavailable })}</span>
      )}
      {account.usageHistoryTruncated && (
        <span className="faint"> · {t("codexAuth.usage7dTruncated")}</span>
      )}
    </div>
  );
}

