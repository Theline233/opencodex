import { formatEstimatedUsdValue } from "../intl-formatters";
import { useI18n } from "../i18n/shared";
import type { CodexAccountEntry } from "./codex-account-pool-types";

export function CodexAccountUsage7d({ account }: { account: CodexAccountEntry }) {
  const { t, locale } = useI18n();
  const usage = account.usage7d;
  const capacity = account.weeklyCapacity;
  if (!usage && !capacity) return null;
  const unavailable = usage ? usage.unpricedRequests + usage.unmeteredRequests : 0;
  const complete = unavailable === 0;
  const confidenceKey = capacity?.confidence === "high"
    ? "codexAuth.weeklyCapacityConfidenceHigh"
    : capacity?.confidence === "medium"
      ? "codexAuth.weeklyCapacityConfidenceMedium"
      : "codexAuth.weeklyCapacityConfidenceLow";

  return (
    <>
      {capacity && (
        <div
          className="card-sub codex-account-usage codex-account-capacity"
          title={t("codexAuth.weeklyCapacityDisclaimer")}
        >
          <span>{t("codexAuth.weeklyCapacityLabel")}</span>{" "}
          {capacity.estimatedTotalCostUsd !== undefined && capacity.estimatedRemainingCostUsd !== undefined ? (
            <>
              <strong className="mono">{formatEstimatedUsdValue(capacity.estimatedTotalCostUsd, locale)}</strong>{" "}
              <span className="faint">
                {t("codexAuth.weeklyCapacityDetail", {
                  observed: formatEstimatedUsdValue(capacity.observedCostUsd, locale),
                  pct: Math.round(capacity.usedPercent * 10) / 10,
                  remaining: formatEstimatedUsdValue(capacity.estimatedRemainingCostUsd, locale),
                  confidence: t(confidenceKey),
                })}
              </span>
            </>
          ) : (
            <span className="faint">
              {t("codexAuth.weeklyCapacityCollecting", { pct: Math.round(capacity.usedPercent * 10) / 10 })}
            </span>
          )}
        </div>
      )}
      {usage && (
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
      )}
    </>
  );
}
