/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 2 mobile expects the dev server reachable from the device/simulator.
// `host: '0.0.0.0'` lets `tauri ios dev` / `tauri android dev` proxy in.
// Port 1420 is the Tauri convention.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    // Source maps in dev only — shipping them deminifies the published artifact.
    sourcemap: mode !== "production",
    outDir: "dist",
  },
  test: {
    // jsdom keeps DOM globals (`window`, `document`, Web Crypto) available
    // for vault + signer tests that exercise SubtleCrypto / atob / btoa.
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
  },
}));
