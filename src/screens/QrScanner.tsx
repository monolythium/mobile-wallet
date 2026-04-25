// QR scanner screen.
//
// Library: `@zxing/browser` (BrowserMultiFormatReader). We chose it over the
// Tauri 2 mobile barcode plugin because:
//
//   1. It runs in the webview — no native plugin glue to add per-platform
//      and no Tauri 2 mobile barcode plugin in the official lineup as of
//      the date this lands.
//   2. The same code path runs on desktop hosts (camera permission via
//      WebRTC), so devs without a phone can still smoke-test a QR funnel.
//   3. It hands us a typed string, which we feed straight into the same
//      `parseDeepLink` parser that the OS-delivered URL schemes use —
//      QR + URL scheme funnel through one parser, per Stage 4 brief.
//
// Camera permission lives at the WebView layer (`navigator.mediaDevices`).
// On iOS that maps to `NSCameraUsageDescription` — needs to be present in
// `Info.plist` once `tauri ios init` is run. On Android it maps to
// `android.permission.CAMERA` in the manifest — likewise added at init.
// Stage 4 ships the JS path; the manifest entries are tracked as a Stage 5
// follow-up because they live in the platform-specific `gen/` projects
// that aren't initialised yet.

import { useEffect, useRef, useState } from "react";
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
import { Icon } from "../components/Icon";
import { parseDeepLink, type DeepLinkAction } from "../sdk/deeplink";

interface Props {
  onResult: (action: DeepLinkAction) => void;
  onClose: () => void;
}

type ScannerState = "loading" | "scanning" | "denied" | "error";

export function QrScanner({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [state, setState] = useState<ScannerState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");

  useEffect(() => {
    let cancelled = false;
    const reader = new BrowserMultiFormatReader();

    const start = async () => {
      try {
        const video = videoRef.current;
        if (!video) return;

        // `decodeFromVideoDevice(undefined, video, …)` lets the browser
        // pick the rear camera — `undefined` defers to the platform
        // default, which on mobile is the rear lens. The third arg is the
        // result callback, fired on every successful decode.
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          video,
          (result, err) => {
            if (cancelled) return;
            if (result) {
              const text = result.getText();
              const action = parseDeepLink(text);
              // Stop scanning before bubbling — otherwise the next frame
              // fires the callback again before the parent unmounts us.
              controlsRef.current?.stop();
              onResult(action);
              return;
            }
            if (err && err.name !== "NotFoundException") {
              // NotFoundException fires every frame the camera doesn't
              // see a code; that's normal noise. Surface other errors
              // (PermissionDenied, hardware failure) to the user.
              setError(err.message);
            }
          },
        );

        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setState("scanning");
      } catch (cause) {
        if (cancelled) return;
        const e = cause as Error & { name?: string };
        // `NotAllowedError` = user denied permission. Everything else is
        // hardware / environment failure (no camera available, blocked by
        // policy, etc.).
        if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
          setState("denied");
        } else {
          setError(e?.message ?? String(cause));
          setState("error");
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [onResult]);

  const submitPaste = () => {
    const trimmed = paste.trim();
    if (!trimmed) return;
    onResult(parseDeepLink(trimmed));
  };

  return (
    <div className="mw-scanner" role="dialog" aria-label="Scan QR code">
      <div className="mw-scanner__head">
        <button className="mw-iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <div className="mw-scanner__title">Scan</div>
        <div style={{ width: 36 }} />
      </div>

      <div className="mw-scanner__stage">
        <video
          ref={videoRef}
          className="mw-scanner__video"
          playsInline
          muted
          autoPlay
        />
        {state === "scanning" && (
          <div className="mw-scanner__overlay" aria-hidden="true">
            <div className="mw-scanner__frame" />
            <div className="mw-scanner__hint">
              Point at a QR code · address, send link, or WalletConnect
            </div>
          </div>
        )}
        {state === "loading" && (
          <div className="mw-scanner__overlay" aria-live="polite">
            <div className="mw-spin" />
            <div className="mw-scanner__hint">Opening camera…</div>
          </div>
        )}
        {state === "denied" && (
          <div className="mw-scanner__overlay" aria-live="polite">
            <div style={{ fontSize: 15, fontWeight: 500 }}>
              Camera permission denied
            </div>
            <div className="mw-scanner__hint">
              Enable camera access for Monolythium Wallet in your device
              settings, or paste the request below.
            </div>
          </div>
        )}
        {state === "error" && (
          <div className="mw-scanner__overlay" aria-live="polite">
            <div style={{ fontSize: 15, fontWeight: 500 }}>Camera failed</div>
            <div className="mw-scanner__hint">{error}</div>
          </div>
        )}
      </div>

      <div className="mw-scanner__paste">
        <label htmlFor="mw-paste-input" className="mw-scanner__paste-label">
          Or paste a wallet link
        </label>
        <input
          id="mw-paste-input"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitPaste();
          }}
          className="mw-scanner__paste-input"
          placeholder="monolythium://send?to=0x… · wc:… · 0x…"
          aria-label="Paste wallet link"
        />
        <button
          type="button"
          className="mw-btn mw-btn--primary mw-btn--block"
          onClick={submitPaste}
          disabled={paste.trim().length === 0}
        >
          Open
        </button>
      </div>
    </div>
  );
}
