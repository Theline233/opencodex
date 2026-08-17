import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { IconKey } from "../icons";
import { useT } from "../i18n/shared";
import { LoginUrlBlock } from "./login-url-block";
import { useCopyFeedback } from "./use-copy-feedback";

type LoginStatus = "waiting" | "activating" | "done" | "error" | "cancelled";

interface LoginState {
  flowId: string;
  status: LoginStatus;
  verificationUri?: string;
  userCode?: string;
  expiresAt: number;
  error?: string;
}

export default function MainAccountLoginModal({
  apiBase,
  onClose,
  onLoggedIn,
}: {
  apiBase: string;
  onClose: () => void;
  onLoggedIn: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<LoginState | null>(null);
  const [startupError, setStartupError] = useState("");
  const [starting, setStarting] = useState(true);
  const completedRef = useRef(false);
  const flowIdRef = useRef("");
  const terminalRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { copy, outcomeFor } = useCopyFeedback<string>();

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const cancel = useCallback(async () => {
    stopPolling();
    const flowId = flowIdRef.current;
    if (flowId && !terminalRef.current) {
      await fetch(`${apiBase}/api/native-main-login/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      }).catch(() => {});
    }
    onClose();
  }, [apiBase, onClose, stopPolling]);

  const poll = useCallback(async (flowId: string) => {
    try {
      const response = await fetch(`${apiBase}/api/native-main-login/status?flowId=${encodeURIComponent(flowId)}`);
      const next = await readJsonOrThrow<LoginState>(response, t("modal.networkError"));
      if (!next) return;
      setState(next);
      if (next.status === "done") {
        terminalRef.current = true;
        stopPolling();
        if (!completedRef.current) {
          completedRef.current = true;
          onLoggedIn();
          window.setTimeout(onClose, 700);
        }
      } else if (next.status === "error" || next.status === "cancelled") {
        terminalRef.current = true;
        stopPolling();
      }
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : t("modal.networkError"));
      stopPolling();
    }
  }, [apiBase, onClose, onLoggedIn, stopPolling, t]);

  useEffect(() => {
    let alive = true;
    const start = async () => {
      try {
        const response = await fetch(`${apiBase}/api/native-main-login/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const started = await readJsonOrThrow<LoginState>(response, t("modal.networkError"));
        if (!started) return;
        if (!alive) {
          await fetch(`${apiBase}/api/native-main-login/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ flowId: started.flowId }),
          }).catch(() => {});
          return;
        }
        flowIdRef.current = started.flowId;
        setState(started);
        setStarting(false);
        await poll(started.flowId);
        if (alive) pollRef.current = setInterval(() => { void poll(started.flowId); }, 2000);
      } catch (error) {
        if (!alive) return;
        setStarting(false);
        setStartupError(error instanceof Error ? error.message : t("modal.networkError"));
      }
    };
    void start();
    return () => {
      alive = false;
      stopPolling();
      const flowId = flowIdRef.current;
      if (flowId && !terminalRef.current) {
        void fetch(`${apiBase}/api/native-main-login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId }),
        }).catch(() => {});
      }
    };
  }, [apiBase, poll, stopPolling, t]);

  const deviceCode = state?.userCode ?? "";
  const codeOutcome = deviceCode ? outcomeFor(deviceCode) : null;
  const codeLabel = codeOutcome === "copied"
    ? t("codexAuth.mainLoginCodeCopied")
    : codeOutcome === "unavailable"
      ? t("codexAuth.mainLoginCodeCopyUnavailable")
      : t("codexAuth.mainLoginCopyCode");
  const status = state?.status;

  return (
    <dialog className="modal-overlay" open aria-label={t("codexAuth.mainLoginTitle")}>
      <div className="modal-card" style={{ maxWidth: 480 }}>
        <h3 style={{ marginBottom: 4 }}>{t("codexAuth.mainLoginTitle")}</h3>
        <p className="modal-desc">{t("codexAuth.mainLoginDesc")}</p>

        {starting && <div className="notice" role="status" aria-live="polite">{t("codexAuth.mainLoginPreparing")}</div>}
        {startupError && <div className="notice notice-err" role="alert">{startupError}</div>}

        {state?.verificationUri && <LoginUrlBlock url={state.verificationUri} />}

        {deviceCode && status === "waiting" && (
          <div className="main-account-login-code" role="status" aria-live="polite">
            <div className="muted text-label">{t("codexAuth.mainLoginCodeLabel")}</div>
            <code>{deviceCode}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(deviceCode, deviceCode)}>
              <IconKey width={14} /> <span aria-live="polite">{codeLabel}</span>
            </button>
          </div>
        )}

        {status === "waiting" && <div className="notice-warn" style={{ marginTop: 12 }}>{t("codexAuth.mainLoginSafetyHint")}</div>}
        {status === "activating" && <div className="notice" role="status" aria-live="polite">{t("codexAuth.mainLoginActivating")}</div>}
        {status === "done" && <div className="notice notice-ok" role="status" aria-live="polite">{t("codexAuth.mainLoginSuccess")}</div>}
        {status === "error" && <div className="notice notice-err" role="alert">{state?.error ?? t("codexAuth.mainLoginFailed")}</div>}

        <button type="button" className="btn btn-ghost" onClick={() => { void cancel(); }} style={{ width: "100%", marginTop: 14 }}>
          {t("codexAuth.cancel")}
        </button>
      </div>
    </dialog>
  );
}
