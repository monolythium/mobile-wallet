// Stage 3 mobile entry point. Wires the biometric + keystore commands
// surfaced by `auth.rs`. Native iOS + Android plugin init runs only on
// `cfg(mobile)` so the host `cargo check` stays green without Xcode /
// Android Studio.

mod auth;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        auth::biometric_is_available,
        auth::biometric_authenticate,
        auth::keychain_has,
        auth::keychain_set,
        auth::keychain_get,
        auth::keychain_delete,
    ]);

    let builder = configure_mobile_plugins(builder);

    builder
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Monolythium Wallet Mobile");
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn configure_mobile_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_keystore::init())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn configure_mobile_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    // Desktop host build — plugins aren't linked. `auth::*` commands return
    // `AuthError::Unavailable` and the frontend falls back to its password
    // path. See `auth.rs`.
    builder
}
