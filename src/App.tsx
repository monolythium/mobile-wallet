// Stage 4 — Monolythium Wallet (mobile).
// Layout: single-column scroll with a frosted bottom tab bar. Operations
// drawer rises from the bottom and runs the four-state machine
// (preview -> auth -> executing -> done). All chain reads route through
// `@monolythium/core-sdk` (mono-core-sdk is the single seam).
//
// Stage 4 added:
//   - Deep-link subscriber (monolythium:// + lyth: + wc:) — every URL
//     funnels through `parseDeepLink` and lands either in OperationsDrawer
//     (send / sign) or WalletConnectSheet (proposal / request).
//   - QR scanner (`@zxing/browser`) reachable from the Home screen's Scan
//     affordance and the Sessions "Scan QR code" button. The scan output
//     reuses the same `parseDeepLink` parser as URL schemes — the wallet
//     has exactly one URI parser.
//   - WalletConnect v2 (`@walletconnect/sign-client`) — pair via QR or
//     URL scheme, persist sessions to a Tauri store file, surface
//     incoming `session_proposal` and `session_request` events through
//     the WalletConnectSheet.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./components/Icon";
import {
  OperationsDrawer,
  type OperationRequest,
} from "./components/OperationsDrawer";
import {
  WalletConnectSheet,
  type WcSheetSubject,
} from "./components/WalletConnectSheet";
import { Home } from "./screens/Home";
import { Keys } from "./screens/Keys";
import { Operator } from "./screens/Operator";
import { Audit } from "./screens/Audit";
import { Alerts } from "./screens/Alerts";
import { Ask } from "./screens/Ask";
import { Onboarding } from "./screens/Onboarding";
import { QrScanner } from "./screens/QrScanner";
import { Sessions } from "./screens/Sessions";
import { Send } from "./screens/Send";
import { Receive } from "./screens/Receive";
import { Settings, type SettingsRoute } from "./screens/Settings";
import { RevealPhrase } from "./screens/settings/RevealPhrase";
import { ResetWallet } from "./screens/settings/ResetWallet";
import { About } from "./screens/settings/About";
import { fetchChainStatus, type ChainStatus } from "./sdk/client";
import {
  buildOfflineWalletReadiness,
  loadWalletReadiness,
  type WalletReadiness,
} from "./sdk/readiness";
import { hasUnlockSecret } from "./sdk/auth";
import { vaultBoundAddress } from "./sdk/vault";
import {
  subscribeDeepLinks,
  type DeepLinkAction,
} from "./sdk/deeplink";
import {
  init as wcInit,
  isConfigured as wcIsConfigured,
  pair as wcPair,
  subscribe as wcSubscribe,
} from "./sdk/wc";
import "./styles/tokens.css";
import "./styles/wallet.css";

type Tab = "home" | "operator" | "alerts" | "ask" | "more";

const TABS: { k: Tab; label: string; icon: IconName }[] = [
  { k: "home", label: "Wallet", icon: "home" },
  { k: "operator", label: "Cluster", icon: "stake" },
  { k: "alerts", label: "Alerts", icon: "alert" },
  { k: "ask", label: "Ask", icon: "search" },
  { k: "more", label: "More", icon: "more" },
];

type MoreScreen =
  | "menu"
  | "keys"
  | "audit"
  | "sessions"
  | "settings"
  | "settings/reveal-phrase"
  | "settings/reset-wallet"
  | "settings/about";

type OnboardingState = "checking" | "needed" | "complete";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [more, setMore] = useState<MoreScreen>("menu");
  const [operation, setOperation] = useState<OperationRequest | null>(null);
  const [wcSubject, setWcSubject] = useState<WcSheetSubject | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<WalletReadiness | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState>("checking");
  const [selfAddress, setSelfAddress] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Probe the platform keystore once on mount. If a secret is present the
  // device has been onboarded; otherwise show the onboarding screen first.
  useEffect(() => {
    let cancelled = false;
    void hasUnlockSecret().then((present) => {
      if (cancelled) return;
      setOnboarding(present ? "complete" : "needed");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // SDK happy-path probe on mount.
  useEffect(() => {
    if (onboarding !== "complete") return;
    let cancelled = false;
    const run = async () => {
      try {
        const s = await fetchChainStatus();
        if (cancelled) return;
        setStatus(s);
        setStatusError(null);
        const walletReadiness = await loadWalletReadiness(s);
        if (!cancelled) setReadiness(walletReadiness);
      } catch (cause) {
        if (!cancelled) {
          const message = (cause as Error)?.message ?? "rpc unreachable";
          setStatusError(message);
          setReadiness(buildOfflineWalletReadiness(message));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [onboarding]);

  // Resolve the vault-bound internal address. The envelope carries it as
  // a plaintext header field so this round-trip never triggers a biometric
  // prompt; public screens convert it to typed mono1 before display.
  useEffect(() => {
    if (onboarding !== "complete") return;
    let cancelled = false;
    void vaultBoundAddress().then((addr) => {
      if (!cancelled) setSelfAddress(addr);
    });
    return () => {
      cancelled = true;
    };
  }, [onboarding]);

  // Action router — single funnel for OS deep links + QR scans + paste.
  const routeAction = useCallback((action: DeepLinkAction) => {
    switch (action.kind) {
      case "send": {
        const valueHuman = action.value
          ? `${action.value} (raw)`
          : "(amount tbd)";
        setOperation({
          kind: "send",
          title: "Send LYTH",
          summary: `External send request for ${shortAddr(action.to)}.`,
          details: [
            { k: "To", v: action.to, mono: true },
            { k: "Asset", v: action.token ? "ERC-20" : "LYTH" },
            { k: "Value", v: valueHuman, mono: true },
            ...(action.token
              ? [{ k: "Token", v: action.token, mono: true }]
              : []),
            ...(action.chainId
              ? [{ k: "Chain", v: String(action.chainId), mono: true }]
              : []),
          ],
          confirmLabel: "Sign and send",
        });
        break;
      }
      case "stake": {
        const cluster = action.cluster ?? (action.clusterId !== undefined ? `C-${String(action.clusterId).padStart(3, "0")}` : "selected cluster");
        setOperation({
          kind: "stake",
          title: "Stake LYTH",
          summary: `External staking request for ${cluster}.`,
          details: [
            { k: "Cluster", v: cluster, mono: true },
            ...(action.clusterId !== undefined
              ? [{ k: "Cluster ID", v: String(action.clusterId), mono: true }]
              : []),
            ...(action.chainId
              ? [{ k: "Chain", v: String(action.chainId), mono: true }]
              : []),
          ],
          confirmLabel: "Review stake",
        });
        break;
      }
      case "sign-personal": {
        setOperation({
          kind: "sign",
          title: "Sign message",
          summary:
            "An external app is asking you to sign a message. Personal signatures cannot move funds, but they can authorise off-chain actions.",
          details: [
            { k: "Type", v: "personal_sign", mono: true },
            { k: "Message", v: shortHex(action.message), mono: true },
          ],
          confirmLabel: "Sign",
        });
        break;
      }
      case "sign-typed": {
        const preview = (() => {
          try {
            return shortHex(JSON.stringify(action.typedData));
          } catch {
            return "(typed data)";
          }
        })();
        setOperation({
          kind: "sign",
          title: "Sign typed data",
          summary:
            "An external app is asking to sign EIP-712 typed data. Verify the domain and contents — typed signatures can authorise on-chain actions.",
          details: [
            { k: "Type", v: "eth_signTypedData_v4", mono: true },
            { k: "Payload", v: preview, mono: true },
          ],
          confirmLabel: "Sign typed data",
        });
        break;
      }
      case "walletconnect": {
        if (!wcIsConfigured()) {
          setToast(
            "WalletConnect not configured for this build (set VITE_WC_PROJECT_ID).",
          );
          break;
        }
        // Boot SignClient lazily and pair. The matching `session_proposal`
        // arrives via the WC subscriber and pops the WalletConnectSheet.
        void (async () => {
          try {
            await wcPair(action.uri);
            setToast("Pairing… waiting for the dapp's session proposal.");
          } catch (cause) {
            setToast(
              (cause as Error)?.message ??
                "WalletConnect pair failed",
            );
          }
        })();
        break;
      }
      case "unknown":
      default: {
        setToast(`Unrecognised request: ${action.reason}`);
        break;
      }
    }
  }, []);

  // Subscribe to OS-delivered deep links.
  useEffect(() => {
    if (onboarding !== "complete") return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        unsub = await subscribeDeepLinks((action) => {
          if (!cancelled) routeAction(action);
        });
      } catch (cause) {
        // Subscribing to deep links should never throw, but if it does we
        // still want the app to function without the URL feed.
        console.warn("deep-link subscribe failed", cause);
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [onboarding, routeAction]);

  // Subscribe to WalletConnect events. We boot the SignClient lazily on
  // the first pair, but we want the proposal/request events to surface
  // **whenever** they arrive — not just after a pair from this session.
  // (Persisted sessions from a previous run will fire `session_request`
  // immediately on boot once a dapp re-subscribes.)
  useEffect(() => {
    if (onboarding !== "complete") return;
    if (!wcIsConfigured()) return;
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        await wcInit();
        if (cancelled) return;
        unsub = wcSubscribe((e) => {
          if (cancelled) return;
          if (e.kind === "session_proposal") {
            setWcSubject({ kind: "proposal", proposal: e.proposal });
          } else if (e.kind === "session_request") {
            setWcSubject({ kind: "request", request: e.request });
          } else if (e.kind === "session_delete" || e.kind === "session_expire") {
            // Don't auto-pop; the Sessions screen refreshes on open.
          }
        });
      } catch (cause) {
        console.warn("wc init/subscribe failed", cause);
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [onboarding]);

  // Auto-clear toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  if (onboarding === "checking") {
    return <main className="mw-root" data-denom="public" />;
  }

  if (onboarding === "needed") {
    return <Onboarding onDone={() => setOnboarding("complete")} />;
  }

  const openOperation = (req: OperationRequest) => setOperation(req);
  const closeOperation = () => setOperation(null);
  const closeWcSheet = () => setWcSubject(null);

  const openScanner = () => setScannerOpen(true);
  const closeScanner = () => setScannerOpen(false);
  const handleScan = (action: DeepLinkAction) => {
    setScannerOpen(false);
    routeAction(action);
  };

  const title = tabTitle(tab, more);

  return (
    <main className="mw-root" data-denom="public">
      <TopBar
        title={title}
        leading={
          tab === "more" && more !== "menu" ? (
            <button
              className="mw-iconbtn"
              onClick={() => {
                if (more.startsWith("settings/")) setMore("settings");
                else setMore("menu");
              }}
              aria-label="Back"
            >
              <Icon name="back" />
            </button>
          ) : tab === "home" && (sendOpen || receiveOpen) ? (
            <button
              className="mw-iconbtn"
              onClick={() => {
                setSendOpen(false);
                setReceiveOpen(false);
              }}
              aria-label="Back"
            >
              <Icon name="back" />
            </button>
          ) : undefined
        }
        trailing={
          tab !== "more" && !sendOpen && !receiveOpen ? (
            <button
              className="mw-iconbtn"
              onClick={openScanner}
              aria-label="Scan QR code"
            >
              <Icon name="qr" />
            </button>
          ) : undefined
        }
      />

      {tab === "home" && !sendOpen && !receiveOpen && (
        <Home
          status={status}
          statusError={statusError}
          readiness={readiness}
          selfAddress={selfAddress}
          openOperation={openOperation}
          openSend={() => setSendOpen(true)}
          openReceive={() => setReceiveOpen(true)}
          onScan={openScanner}
        />
      )}
      {tab === "home" && sendOpen && selfAddress && (
        <Send
          selfAddress={selfAddress}
          openOperation={openOperation}
          onClose={() => setSendOpen(false)}
        />
      )}
      {tab === "home" && receiveOpen && selfAddress && (
        <Receive
          selfAddress={selfAddress}
          onClose={() => setReceiveOpen(false)}
        />
      )}
      {tab === "operator" && <Operator />}
      {tab === "alerts" && <Alerts openOperation={openOperation} />}
      {tab === "ask" && <Ask openOperation={openOperation} />}
      {tab === "more" && more === "menu" && <MoreMenu setMore={setMore} />}
      {tab === "more" && more === "keys" && <Keys openOperation={openOperation} />}
      {tab === "more" && more === "audit" && <Audit />}
      {tab === "more" && more === "sessions" && (
        <Sessions onAddSession={openScanner} />
      )}
      {tab === "more" && more === "settings" && (
        <Settings
          go={(route: SettingsRoute) => {
            if (route === "menu") setMore("settings");
            else setMore(`settings/${route}` as MoreScreen);
          }}
        />
      )}
      {tab === "more" && more === "settings/reveal-phrase" && (
        <RevealPhrase onClose={() => setMore("settings")} />
      )}
      {tab === "more" && more === "settings/reset-wallet" && (
        <ResetWallet
          onResetComplete={() => {
            setMore("menu");
            setOnboarding("needed");
            setSelfAddress(null);
            setStatus(null);
            setStatusError(null);
            setReadiness(null);
          }}
          onClose={() => setMore("settings")}
        />
      )}
      {tab === "more" && more === "settings/about" && (
        <About onClose={() => setMore("settings")} />
      )}

      {!operation && !wcSubject && !scannerOpen && (
        <nav className="mw-tabbar" aria-label="Primary">
          {TABS.map((t) => (
            <button
              key={t.k}
              className={`mw-tab ${tab === t.k ? "on" : ""}`}
              onClick={() => {
                setTab(t.k);
                if (t.k === "more") setMore("menu");
                setSendOpen(false);
                setReceiveOpen(false);
              }}
              aria-current={tab === t.k ? "page" : undefined}
            >
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      )}

      <OperationsDrawer request={operation} onClose={closeOperation} />
      <WalletConnectSheet subject={wcSubject} onClose={closeWcSheet} />
      {scannerOpen && (
        <QrScanner onResult={handleScan} onClose={closeScanner} />
      )}

      {toast && <div className="mw-toast">{toast}</div>}
    </main>
  );
}

function TopBar({
  title,
  leading,
  trailing,
}: {
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <header className="mw-top">
      {leading ?? <div style={{ width: 36 }} />}
      <div className="mw-top__title">
        {!leading && <span className="brand" aria-hidden="true" />}
        {title}
      </div>
      {trailing ?? <div style={{ width: 36 }} />}
    </header>
  );
}

function MoreMenu({ setMore }: { setMore: (s: MoreScreen) => void }) {
  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Security</h3>
        </div>
        <button
          className="mw-row"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => setMore("keys")}
        >
          <div className="mw-row__icon">
            <Icon name="key" size={14} />
          </div>
          <div>
            <div className="mw-row__name">Keys</div>
            <div className="mw-row__sub">3 trusted · review and pair</div>
          </div>
          <div className="mw-row__right">
            <Icon name="chev" size={14} />
          </div>
        </button>
        <button
          className="mw-row"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => setMore("audit")}
        >
          <div className="mw-row__icon">
            <Icon name="audit" size={14} />
          </div>
          <div>
            <div className="mw-row__name">Audit trail</div>
            <div className="mw-row__sub">Every action this device signed</div>
          </div>
          <div className="mw-row__right">
            <Icon name="chev" size={14} />
          </div>
        </button>
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Connections</h3>
        </div>
        <button
          className="mw-row"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => setMore("sessions")}
        >
          <div className="mw-row__icon">
            <Icon name="qr" size={14} />
          </div>
          <div>
            <div className="mw-row__name">WalletConnect</div>
            <div className="mw-row__sub">Active sessions and pairing</div>
          </div>
          <div className="mw-row__right">
            <Icon name="chev" size={14} />
          </div>
        </button>
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Wallet</h3>
        </div>
        <button
          className="mw-row"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => setMore("settings")}
        >
          <div className="mw-row__icon">
            <Icon name="settings" size={14} />
          </div>
          <div>
            <div className="mw-row__name">Settings</div>
            <div className="mw-row__sub">
              Recovery phrase · Reset · About
            </div>
          </div>
          <div className="mw-row__right">
            <Icon name="chev" size={14} />
          </div>
        </button>
      </div>
    </div>
  );
}

function tabTitle(tab: Tab, more: MoreScreen): string {
  switch (tab) {
    case "home":
      return "Monolythium Wallet";
    case "operator":
      return "Cluster";
    case "alerts":
      return "Alerts";
    case "ask":
      return "Ask";
    case "more":
      if (more === "keys") return "Keys";
      if (more === "audit") return "Audit";
      if (more === "sessions") return "WalletConnect";
      if (more === "settings") return "Settings";
      if (more === "settings/reveal-phrase") return "Recovery phrase";
      if (more === "settings/reset-wallet") return "Reset wallet";
      if (more === "settings/about") return "About";
      return "More";
  }
}

function shortAddr(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function shortHex(s: string): string {
  if (s.length <= 36) return s;
  return `${s.slice(0, 18)}…${s.slice(-14)}`;
}
