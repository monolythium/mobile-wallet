// Stage 2 — Monolythium Wallet (mobile).
// Mobile-adapted port of designs/src/wallet-mobile.jsx + selected consumer
// surfaces from designs/src/{home,operator,keys,ask,audit,alerts}.jsx.
//
// Layout: single-column scroll with a frosted bottom tab bar. Operations
// drawer rises from the bottom and runs the four-state machine
// (preview -> auth -> executing -> done). All chain reads route through
// `@monolythium/core-sdk` (mono-core-sdk is the single seam).

import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./components/Icon";
import {
  OperationsDrawer,
  type OperationRequest,
} from "./components/OperationsDrawer";
import { Home } from "./screens/Home";
import { Keys } from "./screens/Keys";
import { Operator } from "./screens/Operator";
import { Audit } from "./screens/Audit";
import { Alerts } from "./screens/Alerts";
import { Ask } from "./screens/Ask";
import { fetchChainStatus, type ChainStatus } from "./sdk/client";
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

type MoreScreen = "menu" | "keys" | "audit";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [more, setMore] = useState<MoreScreen>("menu");
  const [operation, setOperation] = useState<OperationRequest | null>(null);
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // SDK happy-path probe on mount. Real RPC call against the configured
  // Monolythium v2 testnet endpoint; renders a degraded badge on failure.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const s = await fetchChainStatus();
        if (!cancelled) setStatus(s);
      } catch (cause) {
        if (!cancelled)
          setStatusError((cause as Error)?.message ?? "rpc unreachable");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const openOperation = (req: OperationRequest) => setOperation(req);
  const closeOperation = () => setOperation(null);

  const title = tabTitle(tab, more);

  return (
    <main className="mw-root" data-denom="public">
      <TopBar
        title={title}
        leading={
          tab === "more" && more !== "menu" ? (
            <button
              className="mw-iconbtn"
              onClick={() => setMore("menu")}
              aria-label="Back"
            >
              <Icon name="back" />
            </button>
          ) : undefined
        }
      />

      {tab === "home" && (
        <Home
          status={status}
          statusError={statusError}
          openOperation={openOperation}
        />
      )}
      {tab === "operator" && <Operator />}
      {tab === "alerts" && <Alerts openOperation={openOperation} />}
      {tab === "ask" && <Ask openOperation={openOperation} />}
      {tab === "more" && more === "menu" && <MoreMenu setMore={setMore} />}
      {tab === "more" && more === "keys" && <Keys openOperation={openOperation} />}
      {tab === "more" && more === "audit" && <Audit />}

      {!operation && (
        <nav className="mw-tabbar" aria-label="Primary">
          {TABS.map((t) => (
            <button
              key={t.k}
              className={`mw-tab ${tab === t.k ? "on" : ""}`}
              onClick={() => {
                setTab(t.k);
                if (t.k === "more") setMore("menu");
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
    </main>
  );
}

function TopBar({
  title,
  leading,
}: {
  title: string;
  leading?: ReactNode;
}) {
  return (
    <header className="mw-top">
      {leading ?? <div style={{ width: 36 }} />}
      <div className="mw-top__title">
        {!leading && <span className="brand" aria-hidden="true" />}
        {title}
      </div>
      <div style={{ width: 36 }} />
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
          <h3>About</h3>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--fg-300)", lineHeight: 1.55 }}>
          Monolythium Wallet · scaffold v0.0.1 (Stage 2). Native iOS / Android targets
          land once Xcode and Android Studio are configured on the build host.
        </p>
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
      return "More";
  }
}
