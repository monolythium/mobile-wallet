// Stage 4 vault file persistence — the encrypted vault envelope
// (`{ version, salt, params, kekWrappedByDevice, ciphertext, iv }`) is written
// to the app data dir as JSON. The keystore stays single-secret (device-key);
// this module is the on-disk slot for everything else.
//
// Why on disk and not in the keystore: `tauri-plugin-keystore` is single-value
// per app (see `auth.rs`), and the vault envelope is ~300 bytes. Putting it
// next to the platform's per-app data sandbox (iOS app group / Android files
// dir / `~/Library/Application Support/...` on desktop) keeps the keystore
// slot minimal and lets us version the on-disk schema independently.
//
// The bytes are *already* AES-GCM encrypted by the JS layer before they get
// here, so this module is intentionally dumb — read a file, write a file,
// delete a file. No crypto here.

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use thiserror::Error;

const VAULT_FILE: &str = "vault.v1.json";

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum VaultError {
    #[error("vault path resolution failed: {0}")]
    Path(String),
    #[error("vault io error: {0}")]
    Io(String),
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| VaultError::Path(e.to_string()))?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| VaultError::Io(e.to_string()))?;
    }
    Ok(dir.join(VAULT_FILE))
}

#[tauri::command]
pub async fn vault_exists(app: AppHandle) -> Result<bool, VaultError> {
    let p = vault_path(&app)?;
    Ok(p.exists())
}

#[tauri::command]
pub async fn vault_read(app: AppHandle) -> Result<Option<String>, VaultError> {
    let p = vault_path(&app)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(VaultError::Io(e.to_string())),
    }
}

#[tauri::command]
pub async fn vault_write(app: AppHandle, contents: String) -> Result<(), VaultError> {
    let p = vault_path(&app)?;
    // Tauri's app data dir is per-app sandboxed on iOS / Android; on desktop
    // it's `~/Library/Application Support/<bundle id>/` (or platform
    // equivalent). No further hardening needed here — the FS sandbox is
    // the boundary, and the bytes themselves are already AES-GCM ciphertext.
    fs::write(&p, contents.as_bytes()).map_err(|e| VaultError::Io(e.to_string()))
}

#[tauri::command]
pub async fn vault_delete(app: AppHandle) -> Result<(), VaultError> {
    let p = vault_path(&app)?;
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(VaultError::Io(e.to_string())),
    }
}
