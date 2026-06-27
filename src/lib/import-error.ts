// User-readable explanations for recovery-phrase import errors.
//
// The SDK's validateMnemonic / mnemonicToAddress raise typed
// `MnemonicError`s with terse, developer-targeted messages
// ("mnemonic must be 24 words, got 12", "bip39 decode failed"). The
// mobile vault layer (`sdk/vault.ts`) wraps those as `VaultMnemonicError`
// with a "recovery phrase is not valid: …" prefix, then the Onboarding
// screen used to surface the wrapped message verbatim — confusing for
// users who have no context for "bip39 decode".
//
// This helper pattern-matches the raw error message and returns the
// user-facing string the UI should render. Substring matching means
// the wrapper prefix added by VaultMnemonicError doesn't interfere
// with detection. Unknown messages fall through to the original
// `reason` so we never drop information.
//
// Recovery phrases are standard 24-word BIP-39. A phrase that isn't 24
// words, or fails the BIP-39 checksum (a typo, or a phrase from a wallet
// that uses a different word count), is rejected before any key is
// derived — we replace the raw error with an explanation users can act on.

export function explainImportError(reason: string): string {
  if (/already exists/i.test(reason)) {
    return "This recovery phrase is already imported on this wallet.";
  }
  if (/(must be \d+ words|24-word|word count)/i.test(reason)) {
    return "A Monolythium recovery phrase is 24 words. Check that you've pasted all of them.";
  }
  if (/(bip-?39|checksum|wordlist|not a valid|decode)/i.test(reason)) {
    return "Invalid recovery phrase — one or more words aren't in the BIP-39 wordlist, or the checksum is wrong. Check for typos.";
  }
  return reason;
}
