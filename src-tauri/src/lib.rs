// Stage 0 mobile entry point. No commands wired yet; Stage 1 will add typed
// Rust commands for keychain (iOS Keychain Services / Android Keystore) and
// mono-core-sdk RPC plumbing. Native iOS + Android project init is deferred
// — see plans/mobile-wallet.md.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Monolythium Wallet Mobile");
}
