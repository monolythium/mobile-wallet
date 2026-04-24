// Compact icon set, ported from designs/src/wallet-mobile.jsx.
// React 19 type-by-inference; no JSX.Element annotations.

interface IconProps {
  name: IconName;
  size?: number;
}

export type IconName =
  | "home"
  | "wallet"
  | "stake"
  | "activity"
  | "more"
  | "send"
  | "receive"
  | "buy"
  | "scan"
  | "qr"
  | "shield"
  | "settings"
  | "bridge"
  | "close"
  | "back"
  | "chev"
  | "face"
  | "copy"
  | "search"
  | "key"
  | "check"
  | "alert"
  | "audit";

export function Icon({ name, size = 18 }: IconProps) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "home":
      return (
        <svg {...p}>
          <path d="M3 10.5 12 3l9 7.5V21H3z" />
          <path d="M9 21v-7h6v7" />
        </svg>
      );
    case "wallet":
      return (
        <svg {...p}>
          <path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M3 7V5a2 2 0 0 1 2-2h11v4" />
          <circle cx="17" cy="13.5" r="1.5" fill="currentColor" />
        </svg>
      );
    case "stake":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="5" cy="18" r="2" />
          <circle cx="19" cy="18" r="2" />
        </svg>
      );
    case "activity":
      return (
        <svg {...p}>
          <path d="M3 12h4l3-8 4 16 3-8h4" />
        </svg>
      );
    case "more":
      return (
        <svg {...p}>
          <circle cx="5" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="19" cy="12" r="1.5" fill="currentColor" />
        </svg>
      );
    case "send":
      return (
        <svg {...p}>
          <path d="M22 2 11 13" />
          <path d="M22 2l-7 20-4-9-9-4z" />
        </svg>
      );
    case "receive":
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12l7 7 7-7" />
        </svg>
      );
    case "buy":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v10M8 12h8" />
        </svg>
      );
    case "scan":
      return (
        <svg {...p}>
          <path d="M3 7V4h3M3 17v3h3M21 7V4h-3M21 17v3h-3" />
          <path d="M7 12h10" />
        </svg>
      );
    case "qr":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="3" height="3" />
          <rect x="18" y="18" width="3" height="3" />
        </svg>
      );
    case "shield":
      return (
        <svg {...p}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case "settings":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      );
    case "bridge":
      return (
        <svg {...p}>
          <path d="M2 17c2-4 4-4 6-4s3 4 8 4M2 13c2-4 4-4 6-4s4 4 8 4" />
        </svg>
      );
    case "close":
      return (
        <svg {...p}>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      );
    case "back":
      return (
        <svg {...p}>
          <path d="M15 18l-6-6 6-6" />
        </svg>
      );
    case "chev":
      return (
        <svg {...p}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "face":
      return (
        <svg {...p}>
          <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
          <circle cx="9" cy="11" r="0.8" fill="currentColor" />
          <circle cx="15" cy="11" r="0.8" fill="currentColor" />
          <path d="M9 15c.8 1 2 1.5 3 1.5S14.2 16 15 15" />
        </svg>
      );
    case "copy":
      return (
        <svg {...p}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "search":
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "key":
      return (
        <svg {...p}>
          <circle cx="7.5" cy="15.5" r="3.5" />
          <path d="M10 13l8.5-8.5M14.5 8.5l3 3M17 5.5l3 3" />
        </svg>
      );
    case "check":
      return (
        <svg {...p}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "alert":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
      );
    case "audit":
      return (
        <svg {...p}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M9 13h6M9 17h4" />
        </svg>
      );
    default:
      return null;
  }
}
