// Stage 0/1 placeholder. Real chrome ports from designs/wallet-mobile.jsx +
// designs/ios-frame.jsx + designs/android-frame.jsx — tracked in plans/mobile-wallet.md.
export default function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        padding: "calc(env(safe-area-inset-top, 0px) + 1.5rem) 1.5rem calc(env(safe-area-inset-bottom, 0px) + 1.5rem)",
        background: "#0a0a0c",
        color: "#f5f5f7",
        fontFamily:
          "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontWeight: 500, letterSpacing: "-0.01em", margin: 0 }}>
        Monolythium Wallet
      </h1>
      <p style={{ opacity: 0.75, margin: 0 }}>Mobile — scaffold v0.0.1</p>
      <p style={{ opacity: 0.55, fontSize: "0.85rem", margin: 0 }}>
        (iOS + Android native project init pending)
      </p>
    </main>
  );
}
