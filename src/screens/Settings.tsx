// Settings — menu of wallet-level actions. Sub-routes are rendered by
// the parent shell; this screen owns the index list only.

import { Icon, type IconName } from "../components/Icon";

export type SettingsRoute =
  | "menu"
  | "contacts"
  | "privacy"
  | "reveal-phrase"
  | "reset-wallet"
  | "about"
  | "experimental";

interface Props {
  go: (route: SettingsRoute) => void;
}

interface Row {
  route: Exclude<SettingsRoute, "menu">;
  icon: IconName;
  title: string;
  subtitle: string;
  destructive?: boolean;
}

const WALLET_ROWS: Row[] = [
  {
    route: "contacts",
    icon: "wallet",
    title: "Contacts",
    subtitle: "Saved recipient addresses",
  },
  {
    route: "privacy",
    icon: "shield",
    title: "Privacy",
    subtitle: "Show the Public / Private balance toggle",
  },
  {
    route: "reveal-phrase",
    icon: "key",
    title: "Reveal recovery phrase",
    subtitle: "24-word PQM-1 phrase · password required",
  },
  {
    route: "reset-wallet",
    icon: "alert",
    title: "Reset wallet",
    subtitle: "Wipe this device and start over",
    destructive: true,
  },
  {
    route: "about",
    icon: "settings",
    title: "About",
    subtitle: "Build · network · version",
  },
];

const ADVANCED_ROWS: Row[] = [
  {
    route: "experimental",
    icon: "settings",
    title: "Experimental features",
    subtitle: "Opt in to in-development surfaces",
  },
];

function SettingsRow({ row, go }: { row: Row; go: Props["go"] }) {
  return (
    <button
      className="mw-row"
      style={{ width: "100%", textAlign: "left" }}
      onClick={() => go(row.route)}
    >
      <div className="mw-row__icon">
        <Icon name={row.icon} size={14} />
      </div>
      <div>
        <div
          className="mw-row__name"
          style={row.destructive ? { color: "var(--err)" } : undefined}
        >
          {row.title}
        </div>
        <div className="mw-row__sub">{row.subtitle}</div>
      </div>
      <div className="mw-row__right">
        <Icon name="chev" size={14} />
      </div>
    </button>
  );
}

export function Settings({ go }: Props) {
  return (
    <div className="mw-scroll">
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Wallet</h3>
        </div>
        {WALLET_ROWS.map((row) => (
          <SettingsRow key={row.route} row={row} go={go} />
        ))}
      </div>

      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Advanced</h3>
        </div>
        {ADVANCED_ROWS.map((row) => (
          <SettingsRow key={row.route} row={row} go={go} />
        ))}
      </div>
    </div>
  );
}
