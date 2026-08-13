import { useI18n } from "../i18n/shared";
import type { TFn } from "../i18n/shared";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { useEffect, useState } from "react";

function formatSubscriptionDate(activeUntil: string, locale: string): string | null {
  const parsed = new Date(activeUntil);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function subscriptionLabel(t: TFn, account: CodexAccountEntry, locale: string, now: number): string {
  const activeUntil = account.subscription?.activeUntil;
  if (!activeUntil) {
    return account.subscription?.lastErrorCode
      ? t("codexAuth.subscriptionLookupFailed")
      : t("codexAuth.subscriptionUnknown");
  }
  const date = formatSubscriptionDate(activeUntil, locale);
  if (!date) return t("codexAuth.subscriptionUnknown");
  return Date.parse(activeUntil) <= now
    ? t("codexAuth.subscriptionExpired", { date })
    : t("codexAuth.subscriptionExpires", { date });
}

export function CodexSubscriptionStatus({
  account,
}: {
  account: CodexAccountEntry;
}) {
  const { locale, t } = useI18n();
  const dateLocale = locale === "zh" ? "zh-CN" : locale;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = account.subscription?.activeUntil
    ? Date.parse(account.subscription.activeUntil) <= now
    : false;
  const activeUntil = account.subscription?.activeUntil;
  const parsedUntil = activeUntil ? Date.parse(activeUntil) : Number.NaN;
  const hasDate = Number.isFinite(parsedUntil);
  const daysRemaining = hasDate ? Math.ceil((parsedUntil - now) / (24 * 60 * 60 * 1000)) : null;
  const tone = !hasDate || account.subscription?.lastErrorCode
    ? "unknown"
    : expired
      ? "expired"
      : daysRemaining !== null && daysRemaining <= 7
        ? "urgent"
        : "active";
  const relativeDate = hasDate && daysRemaining !== null
    ? new Intl.RelativeTimeFormat(dateLocale, { numeric: "always" }).format(daysRemaining, "day")
    : null;
  return (
    <div
      className={`codex-subscription-status codex-subscription-status--${tone}`}
      title={subscriptionLabel(t, account, dateLocale, now)}
    >
      <span className="badge codex-subscription-status__label">{t("codexAuth.subscriptionLabel")}</span>
      {hasDate ? (
        <>
          <strong className="codex-subscription-status__date mono">{formatSubscriptionDate(activeUntil!, dateLocale)}</strong>
          <span className="codex-subscription-status__relative">{relativeDate}</span>
        </>
      ) : (
        <span className="codex-subscription-status__unknown">{subscriptionLabel(t, account, dateLocale, now)}</span>
      )}
    </div>
  );
}
