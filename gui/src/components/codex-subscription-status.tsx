import { IconRefresh } from "../icons";
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
  refreshing,
  refreshBusy,
  onRefresh,
}: {
  account: CodexAccountEntry;
  refreshing: boolean;
  refreshBusy: boolean;
  onRefresh: () => void;
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
  return (
    <div className={`card-sub${expired || account.subscription?.lastErrorCode ? " faint" : ""}`}>
      <span>{t("codexAuth.subscriptionLabel")}: {subscriptionLabel(t, account, dateLocale, now)}</span>{" "}
      <button
        type="button"
        className="btn btn-ghost btn-sm codex-auth-action-btn"
        onClick={onRefresh}
        disabled={refreshBusy}
        aria-label={t("codexAuth.refreshSubscriptionAria", { account: account.alias ?? account.email })}
      >
        <IconRefresh width={13} /> {refreshing
          ? t("codexAuth.refreshingSubscription")
          : t("codexAuth.refreshSubscription")}
      </button>
    </div>
  );
}
