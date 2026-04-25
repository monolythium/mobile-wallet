// Stage 4 — WalletConnect v2 approval sheet.
//
// Two flows render the same drawer chrome:
//   1. **Session proposal** — a dapp wants to pair. Show metadata (name,
//      url, icon), the chains they're requesting, and the methods they
//      plan to call. The user approves or rejects. Approval registers a
//      session keyed on the topic; reject sends back `USER_REJECTED`.
//   2. **JSON-RPC request** — an existing session calls
//      `personal_sign` / `eth_signTypedData_v4` / `eth_sendTransaction`.
//      We render the request payload + a "Approve" / "Reject" pair. Stage 4
//      does not have real keys yet (vault payload is a stub), so approving
//      a sign/send sends a typed `WC_METHOD_UNSUPPORTED` error back to the
//      dapp with a frontend banner explaining "vault not yet seeded".
//      Stage 5 will replace that with the real signer.
//
// Auth gate: the user still has to pass biometric/password before any
// approval (proposal or request) is forwarded to the relay. This reuses
// `authorizeOperation` from the auth seam — same gate as send/sign in the
// regular OperationsDrawer.

import { useEffect, useMemo, useState } from "react";
import type {
  SignClientTypes,
} from "@walletconnect/types";
import { Icon } from "./Icon";
import { authorizeOperation, type AuthError } from "../sdk/auth";
import {
  approveSession as wcApproveSession,
  rejectSession as wcRejectSession,
  rejectRequest as wcRejectRequest,
} from "../sdk/wc";
import { upsertSession } from "../sdk/wcStore";

type Proposal = SignClientTypes.EventArguments["session_proposal"];
type RpcRequest = SignClientTypes.EventArguments["session_request"];

export type WcSheetSubject =
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "request"; request: RpcRequest };

interface Props {
  subject: WcSheetSubject | null;
  onClose: () => void;
}

type Stage = "preview" | "auth" | "running" | "done";

export function WalletConnectSheet({ subject, onClose }: Props) {
  const [stage, setStage] = useState<Stage>("preview");
  const [error, setError] = useState<string | null>(null);
  const [resultLine, setResultLine] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"biometric" | "password">("biometric");
  const [pwResolver, setPwResolver] = useState<
    ((value: string | null) => void) | null
  >(null);

  useEffect(() => {
    if (subject) {
      setStage("preview");
      setError(null);
      setResultLine(null);
      setAuthMode("biometric");
      setPassword("");
      setPwResolver(null);
    }
  }, [subject]);

  const meta = useMemo(() => describe(subject), [subject]);

  if (!subject) return null;

  const handleApprove = async () => {
    setStage("auth");
    try {
      const ok = await authorizeOperation(meta.summary, () =>
        new Promise<string | null>((resolve) => {
          setPwResolver(() => resolve);
          setAuthMode("password");
        }),
      );
      if (!ok) {
        setError("authorisation failed");
        setStage("done");
        return;
      }
    } catch (cause) {
      const err = cause as AuthError;
      if (err?.kind === "Cancelled") {
        setStage("preview");
        setAuthMode("biometric");
        return;
      }
      setError(err?.message ?? "authorisation failed");
      setStage("done");
      return;
    }

    setStage("running");
    try {
      if (subject.kind === "proposal") {
        // Stage 4: no real accounts yet (vault is stub). We accept the
        // pair handshake with an empty accounts list so the dapp learns
        // we're a wallet — Stage 5 wires real addresses into this list.
        const session = await wcApproveSession(subject.proposal, []);
        await upsertSession({
          topic: session.topic,
          expiry: session.expiry,
          peerName: session.peer.metadata.name,
          peerUrl: session.peer.metadata.url,
          peerIcon: session.peer.metadata.icons?.[0],
          accounts: session.namespaces["eip155"]?.accounts ?? [],
          chains: session.namespaces["eip155"]?.chains ?? [],
        });
        setResultLine(`paired with ${session.peer.metadata.name}`);
      } else {
        // Stage 4: signing is not yet wired to real keys. Send back an
        // explicit `WC_METHOD_UNSUPPORTED` so the dapp surfaces the
        // failure rather than hanging. Stage 5 replaces this branch with
        // the real signer.
        await wcRejectRequest(subject.request.topic, subject.request.id, "unsupported-method");
        setResultLine(
          "Stage 4 placeholder: no signing key on this device yet. Stage 5 will land seed material.",
        );
      }
      setStage("done");
    } catch (cause) {
      setError((cause as Error)?.message ?? "WalletConnect request failed");
      setStage("done");
    }
  };

  const handleReject = async () => {
    setStage("running");
    try {
      if (subject.kind === "proposal") {
        await wcRejectSession(subject.proposal);
      } else {
        await wcRejectRequest(subject.request.topic, subject.request.id);
      }
      setResultLine("rejected");
      setStage("done");
    } catch (cause) {
      setError((cause as Error)?.message ?? "rejection failed");
      setStage("done");
    }
  };

  const submitPassword = () => {
    pwResolver?.(password);
    setPwResolver(null);
  };

  const cancelPassword = () => {
    pwResolver?.(null);
    setPwResolver(null);
    setStage("preview");
    setAuthMode("biometric");
    setPassword("");
  };

  return (
    <>
      <div
        className="mw-sheet-scrim"
        onClick={stage === "running" ? undefined : onClose}
      />
      <div
        className="mw-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="WalletConnect"
      >
        <div className="mw-sheet__head">
          <button
            className="mw-iconbtn"
            onClick={onClose}
            disabled={stage === "running"}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
          <div className="mw-sheet__title">{meta.title}</div>
          <div style={{ width: 36 }} />
        </div>

        <div className="mw-sheet__body">
          {stage === "preview" && (
            <PreviewBody meta={meta} />
          )}
          {stage === "auth" && authMode === "biometric" && (
            <AuthBody summary={meta.summary} />
          )}
          {stage === "auth" && authMode === "password" && (
            <PasswordBody
              summary={meta.summary}
              password={password}
              setPassword={setPassword}
              onSubmit={submitPassword}
              onCancel={cancelPassword}
            />
          )}
          {stage === "running" && <RunningBody summary={meta.summary} />}
          {stage === "done" && <DoneBody result={resultLine} error={error} />}
        </div>

        <div className="mw-sheet__footer">
          {stage === "preview" && (
            <div style={{ display: "grid", gap: 8 }}>
              <button
                className="mw-btn mw-btn--primary mw-btn--block"
                onClick={handleApprove}
              >
                <Icon name="face" size={16} />
                {meta.approveLabel}
              </button>
              <button className="mw-btn mw-btn--block" onClick={handleReject}>
                Reject
              </button>
            </div>
          )}
          {stage === "auth" && authMode === "biometric" && (
            <button className="mw-btn mw-btn--block" onClick={() => setStage("preview")}>
              Cancel
            </button>
          )}
          {stage === "auth" && authMode === "password" && (
            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              onClick={submitPassword}
              disabled={password.length === 0}
            >
              Unlock
            </button>
          )}
          {stage === "running" && (
            <button className="mw-btn mw-btn--block" disabled>
              Submitting…
            </button>
          )}
          {stage === "done" && (
            <button
              className="mw-btn mw-btn--primary mw-btn--block"
              onClick={onClose}
            >
              Done
            </button>
          )}
        </div>
      </div>
    </>
  );
}

interface SheetMeta {
  title: string;
  summary: string;
  approveLabel: string;
  rows: { k: string; v: string; mono?: boolean }[];
}

function describe(subject: WcSheetSubject | null): SheetMeta {
  if (!subject) {
    return { title: "WalletConnect", summary: "", approveLabel: "Approve", rows: [] };
  }
  if (subject.kind === "proposal") {
    const p = subject.proposal.params;
    const peerMeta = p.proposer.metadata;
    const eip155 =
      p.requiredNamespaces["eip155"] ?? p.optionalNamespaces["eip155"];
    const chains = eip155?.chains ?? [];
    const methods = eip155?.methods ?? [];
    return {
      title: `Pair with ${peerMeta.name}`,
      summary: `${peerMeta.name} (${peerMeta.url}) wants to connect via WalletConnect. They will be able to ask for signatures, but every signing request still pops a separate prompt.`,
      approveLabel: "Approve session",
      rows: [
        { k: "App", v: peerMeta.name },
        { k: "URL", v: peerMeta.url },
        { k: "Chains", v: chains.join(", ") || "(none)", mono: true },
        { k: "Methods", v: methods.join(", ") || "(none)", mono: true },
      ],
    };
  }
  // request
  const r = subject.request.params;
  const method = r.request.method;
  const summary = humaniseRequest(method);
  return {
    title: humaniseTitle(method),
    summary,
    approveLabel: "Approve",
    rows: [
      { k: "Method", v: method, mono: true },
      { k: "Chain", v: r.chainId, mono: true },
      { k: "Topic", v: short(subject.request.topic), mono: true },
    ],
  };
}

function humaniseTitle(method: string): string {
  switch (method) {
    case "personal_sign":
      return "Sign message";
    case "eth_sign":
      return "Sign hash";
    case "eth_signTypedData":
    case "eth_signTypedData_v4":
      return "Sign typed data";
    case "eth_sendTransaction":
      return "Send transaction";
    default:
      return method;
  }
}

function humaniseRequest(method: string): string {
  switch (method) {
    case "personal_sign":
      return "A connected dapp is asking you to sign a message. Signatures are scoped to this app and never expose your seed.";
    case "eth_sendTransaction":
      return "A connected dapp is asking to broadcast a transaction. Review the destination and value before approving.";
    case "eth_signTypedData":
    case "eth_signTypedData_v4":
      return "A connected dapp is asking to sign EIP-712 typed data. Verify the domain and contents — typed signatures can authorise on-chain actions.";
    default:
      return `A connected dapp is asking the wallet to handle ${method}. Approve only if you initiated this request.`;
  }
}

function short(s: string): string {
  return s.length <= 14 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function PreviewBody({ meta }: { meta: SheetMeta }) {
  return (
    <>
      <div className="mw-card" style={{ marginBottom: 14 }}>
        <div className="mw-card__head">
          <h3>Review</h3>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--fg-200)",
            lineHeight: 1.55,
          }}
        >
          {meta.summary}
        </p>
      </div>
      <div className="mw-card">
        {meta.rows.map((row) => (
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
        AI is advisory. Every destructive action requires biometric or
        password approval.
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
      <div
        style={{
          fontSize: 12.5,
          color: "var(--fg-300)",
          maxWidth: 280,
          lineHeight: 1.55,
        }}
      >
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
      <div
        style={{
          fontSize: 12.5,
          color: "var(--fg-300)",
          maxWidth: 280,
          lineHeight: 1.55,
        }}
      >
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

function RunningBody({ summary }: { summary: string }) {
  return (
    <div className="mw-auth">
      <div className="mw-spin" aria-hidden="true" />
      <div style={{ fontSize: 16, fontWeight: 500 }}>Working</div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--fg-300)",
          maxWidth: 280,
          lineHeight: 1.55,
        }}
      >
        {summary}
      </div>
    </div>
  );
}

function DoneBody({ result, error }: { result: string | null; error: string | null }) {
  if (error) {
    return (
      <div className="mw-done">
        <div
          className="mw-done__ring"
          style={{
            background: "rgba(255,138,154,0.12)",
            borderColor: "rgba(255,138,154,0.45)",
            color: "var(--err)",
          }}
          aria-hidden="true"
        >
          <Icon name="alert" size={36} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 500 }}>Failed</div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--fg-300)",
            maxWidth: 280,
            lineHeight: 1.55,
          }}
        >
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
      <div style={{ fontSize: 16, fontWeight: 500 }}>Done</div>
      {result && (
        <div
          style={{
            fontSize: 12,
            color: "var(--fg-300)",
            maxWidth: 280,
            lineHeight: 1.55,
            textAlign: "center",
          }}
        >
          {result}
        </div>
      )}
    </div>
  );
}
