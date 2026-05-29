# Android upload keystore

The mobile wallet's Play Console release is signed with a 4096-bit RSA
upload keystore. Google Play does its own re-signing (Play App Signing)
on the server side; this keystore is the *upload* key only.

## Regenerate (one-time / disaster recovery)

```bash
keytool -genkeypair -v \
    -alias mobile-wallet-upload \
    -keyalg RSA -keysize 4096 -validity 10950 \
    -keystore mono-mobile-wallet-upload.jks -storetype JKS \
    -dname "CN=Mono Labs R&D LLC, OU=Mobile, O=Mono Labs R&D LLC, L=San Francisco, ST=CA, C=US"
```

Record the resulting store + key passwords; you cannot recover them.

## Vault entries

| Key | Value |
|---|---|
| `mono/app/mobile-wallet-upload-keystore-base64` | `base64 -i mono-mobile-wallet-upload.jks` |
| `mono/app/mobile-wallet-upload-keystore-password` | store password (`-storepass`) |
| `mono/app/mobile-wallet-upload-key-alias` | `mobile-wallet-upload` |
| `mono/app/mobile-wallet-upload-key-password` | key password (`-keypass`) |

## After upload

Keep the raw `.jks` off-machine (Blackwell `~/safe/` or equivalent).
The vault entry is the canonical source — local files are convenience
only. If you lose the file you can decode the vault entry back:

```bash
./scripts/vault.sh get mono/app/mobile-wallet-upload-keystore-base64 \
    | base64 -d > mono-mobile-wallet-upload.jks
```

## Why JKS not PKCS12?

`keytool` warns that JKS is "proprietary" and suggests PKCS12. Both work
for Play uploads. Conversion is a one-liner if you ever want to switch:

```bash
keytool -importkeystore \
    -srckeystore mono-mobile-wallet-upload.jks -srcstoretype JKS \
    -destkeystore mono-mobile-wallet-upload.p12 -deststoretype PKCS12
```
