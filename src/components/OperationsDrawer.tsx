// Operations drawer — sheet-style (bottom-up) for mobile.
// State machine: preview -> auth -> executing -> done.
//
// Same semantics as the desktop wallet's side drawer (per workspace CLAUDE
// design contract: every destructive action routes through Operations +
// keychain). On mobile the sheet rises from the bottom and the auth step
// surfaces a Face ID / Touch ID / fingerprint affordance.
//
// AI is advisory, never autonomous (per design_handoff_monarch).

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

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
}

interface Props {
  request: OperationRequest | null;
  onClose: () => void;
}

const AUTH_DURATION_MS = 1100;

export function OperationsDrawer({ request, onClose }: Props) {
  const [state, setState] = useState<OperationState>("preview");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever a fresh request arrives.
  useEffect(() => {
    if (request) {
      setState("preview");
      setReceipt(null);
      setError(null);
    }
  }, [request]);

  // auth -> executing transition is fully synthetic in this scaffold
  // (real biometric prompt lands in Stage 3 via the Tauri biometric plugin).
  useEffect(() => {
    if (state !== "auth") return;
    const id = setTimeout(() => setState("executing"), AUTH_DURATION_MS);
    return () => clearTimeout(id);
  }, [state]);

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
  }, [state, request]);

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
            <PreviewBody summary={request.summary} details={request.details} />
          )}
          {state === "auth" && <AuthBody summary={request.summary} />}
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
          {state === "auth" && (
            <button
              className="mw-btn mw-btn--block"
              onClick={() => setState("preview")}
            >
              Cancel
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
}: {
  summary: string;
  details: OperationKeyValue[];
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
        AI is advisory. Every destructive action requires biometric authorization on
        this device.
      </p>
    </>
  );
}

function AuthBody({ summary }: { summary: string }) {
  return (
    <div className="mw-auth">
      <div className="mw-auth__ring" aria-hidden="true">
        <Icon name="face" size={44} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 500 }}>Awaiting biometric</div>
      <div style={{ fontSize: 12.5, color: "var(--fg-300)", maxWidth: 280, lineHeight: 1.55 }}>
        {summary}
      </div>
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

async function mockExecute(): Promise<string> {
  await new Promise((res) => setTimeout(res, 900));
  // 32-byte zero-padded synthetic hash so the UI can render something
  // until Stage 3 replaces this with rpc.ethSendRawTransaction(...).
  return `0x${"0".repeat(60)}demo`;
}
