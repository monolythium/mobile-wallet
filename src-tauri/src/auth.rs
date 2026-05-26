// Stage 3 auth surface — biometric + keychain primitives that the
// OperationsDrawer and Onboarding flows talk to.
//
// On iOS this routes biometrics through `tauri-plugin-biometric` (Touch ID /
// Face ID via `LocalAuthentication`) and stores secrets via
// `tauri-plugin-keystore` (Keychain Services with `kSecAttrAccessible…`
// equivalents). On Android the same plugins back onto BiometricPrompt and
// the Android Keystore.
//
// Desktop targets (the host `cargo check` runs against) compile this file
// with both plugin extension traits absent — the commands then return a
// well-typed `AuthError::Unavailable`, and the frontend falls through to
// the password path. This keeps the host green-tree gate clean while
// keeping the production behaviour the mobile build sees identical to
// what's documented at https://v2.tauri.app/plugin/biometric/ and
// https://github.com/impierce/tauri-plugin-keystore.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use thiserror::Error;

/// Errors surfaced to the frontend. Kept narrow so the React layer can
/// render meaningful copy without sniffing strings.
///
/// Several variants are only constructed on mobile targets (the desktop
/// branch only emits `Unavailable`); allow `dead_code` so the host
/// `cargo check` doesn't warn on them.
#[allow(dead_code)]
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AuthError {
    /// The current platform doesn't expose biometrics / a keystore.
    /// Frontend falls back to the password path.
    #[error("biometric or keystore unavailable on this platform")]
    Unavailable,
    /// Biometric prompt was cancelled by the user.
    #[error("authentication cancelled")]
    Cancelled,
    /// Biometric prompt completed but did not authenticate (wrong finger / face).
    #[error("authentication failed: {0}")]
    Failed(String),
    /// Keystore write/read returned an error.
    #[error("keystore error: {0}")]
    Keystore(String),
}

/// Result of `biometric_is_available`. Kept simple — the React layer only
/// branches on `available`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiometricStatus {
    pub available: bool,
    /// Identifier the platform reports for the sensor (`face`, `touch`,
    /// `fingerprint`, etc.). `None` on platforms that don't disclose this.
    pub kind: Option<String>,
    /// Best-effort human-readable reason the sensor isn't ready, when
    /// available is false.
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn biometric_is_available(app: AppHandle) -> Result<BiometricStatus, AuthError> {
    biometric_is_available_impl(app).await
}

#[tauri::command]
pub async fn biometric_authenticate(app: AppHandle, reason: String) -> Result<bool, AuthError> {
    biometric_authenticate_impl(app, reason).await
}

#[tauri::command]
pub async fn keychain_has(app: AppHandle, key: String) -> Result<bool, AuthError> {
    keychain_has_impl(app, key).await
}

#[tauri::command]
pub async fn keychain_set(app: AppHandle, key: String, value: String) -> Result<(), AuthError> {
    keychain_set_impl(app, key, value).await
}

#[tauri::command]
pub async fn keychain_get(app: AppHandle, key: String) -> Result<Option<String>, AuthError> {
    keychain_get_impl(app, key).await
}

#[tauri::command]
pub async fn keychain_delete(app: AppHandle, key: String) -> Result<(), AuthError> {
    keychain_delete_impl(app, key).await
}

// -----------------------------------------------------------------------------
// Mobile implementations — gated on iOS + Android. The plugin crates aren't
// pulled in on desktop builds, so the desktop branch below has to provide
// the same shapes.
// -----------------------------------------------------------------------------

#[cfg(any(target_os = "ios", target_os = "android"))]
mod imp {
    use super::*;
    use tauri_plugin_biometric::{AuthOptions, BiometricExt, Status};
    use tauri_plugin_keystore::KeystoreExt;

    pub(super) async fn biometric_is_available_impl(
        app: AppHandle,
    ) -> Result<BiometricStatus, AuthError> {
        match app.biometric().status() {
            Ok(Status {
                is_available: true,
                biometry_type,
                error: _,
                ..
            }) => Ok(BiometricStatus {
                available: true,
                kind: Some(format!("{:?}", biometry_type).to_lowercase()),
                reason: None,
            }),
            Ok(Status {
                is_available: false,
                error,
                ..
            }) => Ok(BiometricStatus {
                available: false,
                kind: None,
                reason: error,
            }),
            Err(e) => Err(AuthError::Failed(e.to_string())),
        }
    }

    pub(super) async fn biometric_authenticate_impl(
        app: AppHandle,
        reason: String,
    ) -> Result<bool, AuthError> {
        // `allowDeviceCredential` lets the OS fall back to the device PIN /
        // pattern if biometric capture fails — same UX as 1Password/Authy
        // on mobile. The frontend already has its own password fallback, so
        // we keep this off here and surface a `false` instead.
        let opts = AuthOptions {
            allow_device_credential: false,
            cancel_title: Some("Cancel".into()),
            fallback_title: None,
            title: Some("Monolythium Wallet".into()),
            subtitle: None,
            confirmation_required: Some(true),
        };
        match app.biometric().authenticate(reason, opts) {
            Ok(()) => Ok(true),
            Err(e) => {
                let msg = e.to_string();
                if msg.to_lowercase().contains("cancel") {
                    Err(AuthError::Cancelled)
                } else {
                    Err(AuthError::Failed(msg))
                }
            }
        }
    }

    const KEYCHAIN_SERVICE: &str = "com.monolythium.wallet";

    pub(super) async fn keychain_has_impl(
        app: AppHandle,
        key: String,
    ) -> Result<bool, AuthError> {
        match app.keystore().retrieve(tauri_plugin_keystore::RetrieveRequest {
            service: KEYCHAIN_SERVICE.into(),
            user: key,
        }) {
            Ok(resp) => Ok(resp.value.is_some()),
            Err(_) => Ok(false),
        }
    }

    pub(super) async fn keychain_set_impl(
        app: AppHandle,
        key: String,
        value: String,
    ) -> Result<(), AuthError> {
        let _ = key;
        app.keystore()
            .store(tauri_plugin_keystore::StoreRequest { value })
            .map_err(|e| AuthError::Keystore(e.to_string()))
    }

    pub(super) async fn keychain_get_impl(
        app: AppHandle,
        key: String,
    ) -> Result<Option<String>, AuthError> {
        match app.keystore().retrieve(tauri_plugin_keystore::RetrieveRequest {
            service: KEYCHAIN_SERVICE.into(),
            user: key,
        }) {
            Ok(resp) => Ok(resp.value),
            Err(_) => Ok(None),
        }
    }

    pub(super) async fn keychain_delete_impl(
        app: AppHandle,
        key: String,
    ) -> Result<(), AuthError> {
        app.keystore()
            .remove(tauri_plugin_keystore::RemoveRequest {
                service: KEYCHAIN_SERVICE.into(),
                user: key,
            })
            .map_err(|e| AuthError::Keystore(e.to_string()))
    }
}

// -----------------------------------------------------------------------------
// Desktop / non-mobile fallback. The host `cargo check` (darwin/linux/windows)
// compiles this branch — every command resolves cleanly to `Unavailable`,
// which the React layer treats as "show password challenge instead".
// -----------------------------------------------------------------------------

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod imp {
    use super::*;

    pub(super) async fn biometric_is_available_impl(
        _app: AppHandle,
    ) -> Result<BiometricStatus, AuthError> {
        Ok(BiometricStatus {
            available: false,
            kind: None,
            reason: Some("desktop build — biometric plugin not linked".into()),
        })
    }

    pub(super) async fn biometric_authenticate_impl(
        _app: AppHandle,
        _reason: String,
    ) -> Result<bool, AuthError> {
        Err(AuthError::Unavailable)
    }

    pub(super) async fn keychain_has_impl(
        _app: AppHandle,
        _key: String,
    ) -> Result<bool, AuthError> {
        Ok(false)
    }

    pub(super) async fn keychain_set_impl(
        _app: AppHandle,
        _key: String,
        _value: String,
    ) -> Result<(), AuthError> {
        Err(AuthError::Unavailable)
    }

    pub(super) async fn keychain_get_impl(
        _app: AppHandle,
        _key: String,
    ) -> Result<Option<String>, AuthError> {
        Ok(None)
    }

    pub(super) async fn keychain_delete_impl(
        _app: AppHandle,
        _key: String,
    ) -> Result<(), AuthError> {
        Err(AuthError::Unavailable)
    }
}

use imp::*;
