// Monoscan explorer URL builders.
//
// Copied verbatim from the browser wallet's `shared/build-info.ts` so the
// explorer base and hash-route shape stay byte-identical across every
// Monolythium wallet surface — a tx/address link opened from mobile lands
// on exactly the same Monoscan page as the same link opened from the
// extension.

/** Monoscan explorer base for a testnet-69420 transaction (hash-routed SPA).
 *  The wallet only links txs whose canonical hash it knows — its own sent
 *  txs. Received / indexer-only activity rows carry no tx hash and get no
 *  link (honest absence; never synthesize a hash). */
export const MONOSCAN_TX_BASE = "https://monoscan.xyz/#/tx/";

/** Build the Monoscan URL for a canonical transaction hash. */
export function monoscanTxUrl(txHash: string): string {
  return `${MONOSCAN_TX_BASE}${txHash}`;
}

/** Monoscan address (wallet) page base. Takes a bech32m address — `mono…`
 *  for accounts, `monoc…` for clusters — never the raw `0x` form. */
export const MONOSCAN_ADDRESS_BASE = "https://monoscan.xyz/#/wallet/";

/** Build the Monoscan address-page URL for a bech32m address. */
export function monoscanAddressUrl(bech32mAddr: string): string {
  return `${MONOSCAN_ADDRESS_BASE}${bech32mAddr}`;
}
