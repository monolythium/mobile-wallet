// Operations drawer — sheet-style (bottom-up) for mobile.
// State machine: preview -> auth -> executing -> done.
//
// Same semantics as the desktop wallet's side drawer (per workspace CLAUDE
// design contract: every destructive action routes through Operations +
// keychain). On mobile the sheet rises from the bottom and the auth step
// surfaces a Face ID / Touch ID / fingerprint affordance.
//
// Stage 3 wires real biometric auth via `authorizeOperation` from
// `sdk/auth.ts`. The chain is:
//   1. Try the OS biometric sensor (Touch ID / Face ID / fingerprint).
//   2. If biometric is unavailable, cancelled, or fails, fall back to a
//      password challenge that's verified against the secret persisted
//      to the platform keystore at onboarding time.
//
// AI is advisory, never autonomous (per design_handoff_monarch).

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  authorizeOperation,
  biometricStatus,
  type AuthError,
  type BiometricStatus,
} from "../sdk/auth";
import { getProvider } from "../sdk/client";
import {
  recordTerminalNotification,
  type NotifyDescriptor,
} from "../sdk/notifications-record";
import { useExperimentalV5 } from "../sdk/use-feature-flags";

export type OperationKind = "send" | "receive" | "stake" | "buy" | "bridge" | "sign";

export type OperationState = "preview" | "auth" | "executing" | "done";

export interface OperationKeyValue {
  k: string;
  v: string;
  mono?: boolean;
}

export interface OperationRequest {
  kind: OperationKind;
  title: string;
  summary: string;
  details: OperationKeyValue[];
  confirmLabel?: string;
  /** Returns the on-chain hash (or another receipt id) after the auth gate. */
  execute?: () => Promise<string>;
  /** Optional structured metadata for the in-app notifications center. When
   *  present AND the experimental surface is enabled, a successful
   *  `execute()` arms a best-effort receipt poll that records a "confirmed"
   *  / "failed" notification on the tx's REAL terminal transition (never
   *  optimistically from broadcast acceptance). Omitted on operations that
   *  don't map to a tracked tx (e.g. plain message signing). */
  notify?: NotifyDescriptor;
}

interface Props {
  request: OperationRequest | null;
  onClose: () => void;
}

export function OperationsDrawer({ request, onClose }: Props) {
  const [state, setState] = useState<OperationState>("preview");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [authMode, setAuthMode] = useState<"biometric" | "password">("biometric");
  const [password, setPassword] = useState("");
  const passwordResolverRef = useRef<((value: string | null) => void) | null>(null);
  // In-app notifications are an experimental-v5 surface: when OFF, no record
  // is ever written and the operation flow is byte-identical to master.
  const notificationsEnabled = useExperimentalV5();

  // Reset whenever a fresh request arrives.
  useEffect(() => {
    if (request) {
      setState("preview");
      setReceipt(null);
      setError(null);
      setAuthMode("biometric");
      setPassword("");
      passwordResolverRef.current = null;
    }
  }, [request]);

  // Probe biometric capability when the drawer opens. Cheap call (returns
  // cached status from the OS); avoids a flash of the wrong UI on entry.
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    void biometricStatus().then((s) => {
      if (!cancelled) setBio(s);
    });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // auth -> executing transition runs the full biometric+password flow.
  useEffect(() => {
    if (state !== "auth" || !request) return;
    let cancelled = false;
    const run = async () => {
      try {
        const ok = await authorizeOperation(request.summary, () =>
          new Promise<string | null>((resolve) => {
            // Stash the resolver so the password sub-form below can
            // complete the promise. Switching to "password" mode reveals
            // the input.
            passwordResolverRef.current = resolve;
            setAuthMode("password");
          }),
        );
        if (cancelled) return;
        if (ok) {
          setState("executing");
        } else {
          setError("authorisation failed");
          setState("done");
        }
      } catch (cause) {
        if (cancelled) return;
        const err = cause as AuthError;
        if (err?.kind === "Cancelled") {
          // User backed out — return to preview rather than failing the op.
          setState("preview");
          return;
        }
        setError(err?.message ?? "authorisation failed");
        setState("done");
      }
    };
    void run();
    return () => {
      cancelled = true;
      // Leaving the auth state without a resolution = cancellation.
      if (passwordResolverRef.current) {
        passwordResolverRef.current(null);
        passwordResolverRef.current = null;
      }
    };
  }, [state, request]);

  // executing -> done transition runs the request's execute() if present,
  // otherwise mocks a hash so the UI flow is exercised end-to-end.
  useEffect(() => {
    if (state !== "executing" || !request) return;
    let cancelled = false;
    const run = async () => {
      try {
        const txHash = request.execute
          ? await request.execute()
          : await mockExecute();
        if (cancelled) return;
        setReceipt(txHash);
        setState("done");
        // Recording hook (experimental-v5 only). Detached + best-effort:
        // it polls for the tx's REAL terminal receipt and records a
        // "confirmed"/"failed" notification on the explicit status bit —
        // never the optimistic broadcast-ack shown above. Survives the
        // drawer closing; never affects this flow.
        if (
          notificationsEnabled &&
          request.notify &&
          isRecordableHash(txHash)
        ) {
          armTerminalNotification(txHash, request.notify);
        }
      } catch (cause) {
        if (cancelled) return;
        setError((cause as Error)?.message ?? "operation failed");
        setState("done");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [state, request, notificationsEnabled]);

  const submitPassword = () => {
    const r = passwordResolverRef.current;
    passwordResolverRef.current = null;
    if (r) r(password);
  };

  const cancelPassword = () => {
    const r = passwordResolverRef.current;
    passwordResolverRef.current = null;
    if (r) r(null);
    setState("preview");
    setAuthMode("biometric");
    setPassword("");
  };

  const sensorLabel = useMemo(() => sensorLabelFor(bio), [bio]);

  if (!request) return null;

  return (
    <>
      <div className="mw-sheet-scrim" onClick={state === "executing" ? undefined : onClose} />
      <div className="mw-sheet" role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="mw-sheet__head">
          <button
            className="mw-iconbtn"
            onClick={onClose}
            disabled={state === "executing"}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
          <div className="mw-sheet__title">{request.title}</div>
          <div style={{ width: 36 }} />
        </div>

        <div className="mw-sheet__body">
          {state === "preview" && (
            <PreviewBody
              summary={request.summary}
              details={request.details}
              sensorLabel={sensorLabel}
            />
          )}
          {state === "auth" && authMode === "biometric" && (
            <AuthBody summary={request.summary} sensorLabel={sensorLabel} />
          )}
          {state === "auth" && authMode === "password" && (
            <PasswordBody
              summary={request.summary}
              password={password}
              setPassword={setPassword}
              onSubmit={submitPassword}
              onCancel={cancelPassword}
            />
          )}
          {state === "executing" && <ExecutingBody summary={request.summary} />}
          {state === "done" && <DoneBody receipt={receipt} error={error} />}
        </div>

        <div className="mw-sheet__footer">
          {state === "preview" && (
            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              onClick={() => setState("auth")}
            >
              <Icon name="face" size={16} />
              {request.confirmLabel ?? "Authorize"}
            </button>
          )}
          {state === "auth" && authMode === "biometric" && (
            <button
              className="mw-btn mw-btn--block"
              onClick={() => setState("preview")}
            >
              Cancel
            </button>
          )}
          {state === "auth" && authMode === "password" && (
            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              onClick={submitPassword}
              disabled={password.length === 0}
            >
              Unlock
            </button>
          )}
          {state === "executing" && (
            <button className="mw-btn mw-btn--block" disabled>
              Submitting…
            </button>
          )}
          {state === "done" && (
            <button className="mw-btn mw-btn--primary mw-btn--block" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function PreviewBody({
  summary,
  details,
  sensorLabel,
}: {
  summary: string;
  details: OperationKeyValue[];
  sensorLabel: string;
}) {
  return (
    <>
      <div className="mw-card" style={{ marginBottom: 14 }}>
        <div className="mw-card__head">
          <h3>Review</h3>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--fg-200)", lineHeight: 1.55 }}>
          {summary}
        </p>
      </div>
      <div className="mw-card">
        {details.map((row) => (
          <div key={row.k} className="mw-kv">
            <div className="k">{row.k}</div>
            <div className={`v${row.mono ? " mono" : ""}`}>{row.v}</div>
          </div>
        ))}
      </div>
      <p
        style={{
          fontSize: 11.5,
          color: "var(--fg-400)",
          lineHeight: 1.55,
          marginTop: 12,
          padding: "0 4px",
        }}
      >
        AI is advisory. Every destructive action requires {sensorLabel} on
        this device.
      </p>
    </>
  );
}

function AuthBody({ summary, sensorLabel }: { summary: string; sensorLabel: string }) {
  return (
    <div className="mw-auth">
      <div className="mw-auth__ring" aria-hidden="true">
        <Icon name="face" size={44} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 500 }}>Awaiting {sensorLabel}</div>
      <div style={{ fontSize: 12.5, color: "var(--fg-300)", maxWidth: 280, lineHeight: 1.55 }}>
        {summary}
      </div>
    </div>
  );
}

function PasswordBody({
  summary,
  password,
  setPassword,
  onSubmit,
  onCancel,
}: {
  summary: string;
  password: string;
  setPassword: (s: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mw-auth">
      <div className="mw-auth__ring" aria-hidden="true">
        <Icon name="key" size={36} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 500 }}>Enter wallet password</div>
      <div style={{ fontSize: 12.5, color: "var(--fg-300)", maxWidth: 280, lineHeight: 1.55 }}>
        {summary}
      </div>
      <input
        type="password"
        autoFocus
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && password.length > 0) onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        className="mw-input"
        placeholder="••••••••"
        aria-label="Wallet password"
        style={{
          width: "100%",
          maxWidth: 280,
          padding: "10px 12px",
          fontSize: 14,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 10,
          color: "var(--fg-100)",
          outline: "none",
        }}
      />
      <button
        type="button"
        onClick={onCancel}
        style={{
          background: "none",
          border: "none",
          color: "var(--fg-400)",
          fontSize: 12,
          marginTop: 4,
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </div>
  );
}

function ExecutingBody({ summary }: { summary: string }) {
  return (
    <div className="mw-auth">
      <div className="mw-spin" aria-hidden="true" />
      <div style={{ fontSize: 16, fontWeight: 500 }}>Submitting to chain</div>
      <div style={{ fontSize: 12.5, color: "var(--fg-300)", maxWidth: 280, lineHeight: 1.55 }}>
        {summary}
      </div>
    </div>
  );
}

function DoneBody({ receipt, error }: { receipt: string | null; error: string | null }) {
  if (error) {
    return (
      <div className="mw-done">
        <div className="mw-done__ring" style={{ background: "rgba(255,138,154,0.12)", borderColor: "rgba(255,138,154,0.45)", color: "var(--err)" }} aria-hidden="true">
          <Icon name="alert" size={36} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 500 }}>Operation failed</div>
        <div style={{ fontSize: 12.5, color: "var(--fg-300)", maxWidth: 280, lineHeight: 1.55 }}>
          {error}
        </div>
      </div>
    );
  }
  return (
    <div className="mw-done">
      <div className="mw-done__ring" aria-hidden="true">
        <Icon name="check" size={36} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 500 }}>Confirmed</div>
      {receipt && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-400)", wordBreak: "break-all", maxWidth: 280 }}>
          {receipt}
        </div>
      )}
    </div>
  );
}

function sensorLabelFor(bio: BiometricStatus | null): string {
  if (!bio || !bio.available) return "biometric or password";
  switch ((bio.kind ?? "").toLowerCase()) {
    case "face":
    case "faceid":
      return "Face ID";
    case "touch":
    case "touchid":
      return "Touch ID";
    case "fingerprint":
      return "fingerprint";
    default:
      return "biometric";
  }
}

async function mockExecute(): Promise<string> {
  await new Promise((res) => setTimeout(res, 900));
  // 32-byte zero-padded synthetic hash so the UI can render something
  // until Stage 3 replaces this with rpc.ethSendRawTransaction(...).
  return `0x${"0".repeat(60)}demo`;
}

/** A real, canonical 32-byte tx hash worth tracking. Filters out the mock
 *  (`mockExecute`) hash and the empty-string sentinel the batch-staking path
 *  returns when nothing landed, so neither produces a notification. */
function isRecordableHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash);
}

/** Resolve the broadcast-time chain id, then arm the detached terminal-
 *  receipt poll. Fire-and-forget: never awaited by the drawer, swallows
 *  every error. */
function armTerminalNotification(txHash: string, notify: NotifyDescriptor): void {
  void (async () => {
    try {
      const chainId = await getProvider().rpcClient.ethChainId();
      await recordTerminalNotification(txHash, chainId, notify);
    } catch {
      // Best-effort: a failed chain-id read or poll never surfaces here.
    }
  })();
}
