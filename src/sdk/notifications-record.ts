// Structured notification metadata shared by the operations UI and the
// durable tracked-tx pipeline.
//
// The OperationsDrawer attaches a `NotifyDescriptor` to its `OperationRequest`;
// on a successful broadcast it enqueues the tx into the durable registry
// (`pending-tx-store.ts`), and the app-level reconcile poller
// (`use-reconcile-poller.ts` → `reconcile.ts`) carries it to terminal and
// records a faithful notification on the explicit receipt status bit — even
// after the sheet is dismissed or the app restarts.

import type { TxOpKind } from "./notifications";

/** Structured notification metadata a screen attaches to its
 *  `OperationRequest` so the recording pipeline can build a faithful record
 *  from the user's own intent (kind / amount / counterparty) plus the
 *  chain's explicit receipt status. Amount + 0x counterparty only — never a
 *  contact name. */
export interface NotifyDescriptor {
  kind: TxOpKind;
  /** Decimal LYTH string (e.g. "12.5"); "" / "0" suppresses the amount in
   *  the row + detail. */
  amountDecimal: string;
  /** Lowercase 0x counterparty (recipient, or precompile for a call). */
  counterparty: string;
}
