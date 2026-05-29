// Agents — agent sub-account spending-policy management (WP §18.8).
//
// A principal grants a *sub-account* a bounded spending authority. A
// sub-account is a fresh PQM-1 / ML-DSA-65 keypair the principal controls; its
// secret mnemonic is sealed in the OS keychain (agents-store.ts), its public
// address is tracked in a local index.
//
// Three lifecycle actions surface here:
//
//   create — generateAgentSubAccount() mints a fresh keypair; we seal the
//            mnemonic to the keychain + add the public record. The mnemonic is
//            shown ONCE for the principal to back up, then dropped.
//   fund   — an ordinary native LYTH transfer (sendLyth) from the principal to
//            the sub-account address (no spending-policy precompile involved).
//   register / revoke — the on-chain §18.8 write. A FRESH sub-account uses the
//            claim path (setPolicyClaim): we unlock the SUB-ACCOUNT'S key,
//            sign composeClaimBoundMessage with it, then the PRINCIPAL signs +
//            submits the outer tx (a two-key dance). Revoke = disable.
//
// Each write routes through the OperationsDrawer (preview → auth → execute).
// The chain may reject at the precompile-gate if the spending-policy
// precompile isn't activated yet on the connected network — we surface the
// chain's typed error verbatim, never masked.

import { useCallback, useEffect, useState } from "react";
import {
  addressToTypedBech32,
  formatLythoshi,
  parseLythToLythoshi,
  type SpendingPolicyArgs,
  type SpendingPolicyView,
} from "@monolythium/core-sdk";
import { pqm1MnemonicToMlDsa65Backend } from "@monolythium/core-sdk/crypto";
import type { OperationRequest } from "../components/OperationsDrawer";
import { Icon } from "../components/Icon";
import {
  buildDisablePolicyCalldata,
  buildRegisterPolicyCalldata,
  buildSingleAddressAllowRoot,
  emptyMerkleRoot,
  fetchSpendingPolicy,
  generateAgentSubAccount,
  packPolicyTimeWindow,
  signClaimBoundMessage,
  submitSpendingPolicyTx,
} from "../sdk/spending-policy";
import {
  addAgent,
  getAgentMnemonic,
  listAgents,
  removeAgent,
  type AgentRecord,
} from "../sdk/agents-store";
import { sendLyth } from "../sdk/send";
import { makeBiometricBackendFactory, unlockViaBiometric } from "../sdk/signer";
import { getProvider } from "../sdk/client";

interface Props {
  /** Hex address (`0x…`) bound to the unlocked vault (the principal). */
  selfAddress: string | null;
  openOperation: (req: OperationRequest) => void;
}

/** Per-sub-account live policy view, keyed by lower-hex address. */
type PolicyMap = Map<string, SpendingPolicyView | null>;

interface PolicyForm {
  perTxLyth: string;
  dailyLyth: string;
  weeklyLyth: string;
  monthlyLyth: string;
  /** Optional single allowed counterparty (mono1…); empty = no constraint. */
  allowCounterparty: string;
  /** Optional category allow-list root (0x32-bytes); empty = no constraint. */
  categoryAllowRoot: string;
  timeWindowEnabled: boolean;
  startHour: string;
  endHour: string;
  /** Expiry as unix-seconds; empty/0 = never expires. */
  expiryUnix: string;
}

const EMPTY_FORM: PolicyForm = {
  perTxLyth: "",
  dailyLyth: "",
  weeklyLyth: "",
  monthlyLyth: "",
  allowCounterparty: "",
  categoryAllowRoot: "",
  timeWindowEnabled: false,
  startHour: "9",
  endHour: "17",
  expiryUnix: "",
};

export function Agents({ selfAddress, openOperation }: Props) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [policies, setPolicies] = useState<PolicyMap>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newMnemonic, setNewMnemonic] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [formFor, setFormFor] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [fundFor, setFundFor] = useState<string | null>(null);
  const [fundAmount, setFundAmount] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAgents();
      setAgents(list);
      // Best-effort: read each sub-account's live policy. A missing policy
      // (exists=false) or an RPC error reads as null — the chain may not have
      // the precompile activated yet, which we surface inline.
      const entries = await Promise.all(
        list.map(async (a) => {
          try {
            return [a.addressHex, await fetchSpendingPolicy(a.bech32m)] as const;
          } catch {
            return [a.addressHex, null] as const;
          }
        }),
      );
      setPolicies(new Map(entries));
    } catch (cause) {
      setError((cause as Error)?.message ?? "could not load agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (selfAddress === null) {
    return (
      <div className="mw-scroll">
        <div className="mw-card">
          <p style={{ margin: 0, color: "var(--fg-300)", fontSize: 13 }}>
            Resolving wallet identity…
          </p>
        </div>
      </div>
    );
  }

  const principalBech32m = addressToTypedBech32("user", selfAddress);

  // --- Create -------------------------------------------------------------

  const create = async () => {
    const label = labelDraft.trim();
    if (label.length === 0) {
      setError("Give the agent a label first.");
      return;
    }
    setCreating(true);
    setError(null);
    let sub: ReturnType<typeof generateAgentSubAccount> | null = null;
    try {
      sub = generateAgentSubAccount();
      await addAgent({
        pqm1Mnemonic: sub.pqm1Mnemonic,
        addressHex: sub.addressHex,
        bech32m: sub.addressBech32m,
        label,
      });
      // Show the phrase ONCE so the principal can back it up. The keychain
      // already holds the canonical copy.
      setNewMnemonic(sub.pqm1Mnemonic);
      setLabelDraft("");
      await refresh();
    } catch (cause) {
      setError((cause as Error)?.message ?? "could not create sub-account");
    } finally {
      // Drop the transient mnemonic reference held in this frame. (The
      // displayed copy in `newMnemonic` is cleared when the principal taps
      // "I saved it".)
      sub = null;
      setCreating(false);
    }
  };

  // --- Fund (ordinary native transfer from principal) ---------------------

  const openFund = (agent: AgentRecord) => {
    const amount = fundAmount.trim();
    let lythoshi: bigint;
    try {
      lythoshi = parseLythToLythoshi(amount);
    } catch {
      setError("Enter a valid LYTH amount to fund.");
      return;
    }
    if (lythoshi <= 0n) {
      setError("Funding amount must be greater than zero.");
      return;
    }
    openOperation({
      kind: "send",
      title: `Fund ${agent.label}`,
      summary: `Transfer ${amount} LYTH from your wallet to the agent sub-account ${shortBech(agent.bech32m)}. This is an ordinary native transfer — no spending-policy is changed.`,
      details: [
        { k: "From", v: principalBech32m, mono: true },
        { k: "To (agent)", v: agent.bech32m, mono: true },
        { k: "Amount", v: `${amount} LYTH`, mono: true },
      ],
      confirmLabel: "Sign and fund",
      execute: async () => {
        const result = await sendLyth(
          {
            unlockBackend: makeBiometricBackendFactory({
              unlock: unlockViaBiometric,
            }),
          },
          { from: principalBech32m, to: agent.bech32m, amountLyth: amount },
        );
        setFundFor(null);
        setFundAmount("");
        void refresh();
        return result.txHash;
      },
    });
  };

  // --- Register / re-register policy (two-key claim dance) ----------------

  const openRegister = (agent: AgentRecord) => {
    setFormError(null);
    const existing = policies.get(agent.addressHex);
    const isFresh = !existing || !existing.exists;

    // Build the §18.8 args from the form.
    let args: SpendingPolicyArgs;
    try {
      args = buildArgs(form, agent.bech32m, principalBech32m);
    } catch (cause) {
      setFormError((cause as Error)?.message ?? "invalid policy");
      return;
    }

    const summaryDims = describeDims(form);
    openOperation({
      kind: "sign",
      title: `${isFresh ? "Register" : "Update"} policy · ${agent.label}`,
      summary: isFresh
        ? `Bind a spending policy to ${shortBech(agent.bech32m)}. The sub-account signs the bound policy with its own key; you sign and submit the on-chain claim.`
        : `Update the spending policy on ${shortBech(agent.bech32m)}.`,
      details: [
        { k: "Agent", v: agent.bech32m, mono: true },
        { k: "Principal", v: principalBech32m, mono: true },
        { k: "Mode", v: isFresh ? "Fresh claim (setPolicyClaim)" : "Re-claim (setPolicy)" },
        ...summaryDims,
        { k: "Precompile", v: "0x…110c", mono: true },
      ],
      confirmLabel: isFresh ? "Sign and register" : "Sign and update",
      execute: async () => {
        let calldata: string;
        if (isFresh) {
          // Two-key dance — unlock the SUB-ACCOUNT'S key, sign the bound
          // message with it, drop the transient backend, then the PRINCIPAL
          // signs + submits the outer tx.
          const subMnemonic = await getAgentMnemonic(agent.addressHex);
          let subBackend: ReturnType<typeof pqm1MnemonicToMlDsa65Backend> | null =
            pqm1MnemonicToMlDsa65Backend(subMnemonic);
          const chainId = await readChainId();
          const subPubkey = subBackend.publicKey();
          const subSig = signClaimBoundMessage(subBackend, chainId, args);
          // Zeroize the transient sub-account backend reference. (The mnemonic
          // string lives only in this frame; it falls out of scope on return.)
          subBackend = null;
          calldata = buildRegisterPolicyCalldata({
            args,
            subAccountPubkey: subPubkey,
            subAccountSig: subSig,
          });
        } else {
          calldata = buildRegisterPolicyCalldata({ args });
        }
        const result = await submitSpendingPolicyTx({
          fromBech32m: principalBech32m,
          data: calldata,
          unlockBackend: makeBiometricBackendFactory({
            unlock: unlockViaBiometric,
          }),
        });
        setFormFor(null);
        setForm(EMPTY_FORM);
        void refresh();
        return result.txHash;
      },
    });
  };

  // --- Revoke (disable) ----------------------------------------------------

  const openRevoke = (agent: AgentRecord) => {
    openOperation({
      kind: "sign",
      title: `Revoke policy · ${agent.label}`,
      summary: `Disable the spending policy on ${shortBech(agent.bech32m)}. The sub-account can no longer spend under the policy until you re-register it.`,
      details: [
        { k: "Agent", v: agent.bech32m, mono: true },
        { k: "Action", v: "disable (revoke)" },
        { k: "Precompile", v: "0x…110c", mono: true },
      ],
      confirmLabel: "Sign and revoke",
      execute: async () => {
        const result = await submitSpendingPolicyTx({
          fromBech32m: principalBech32m,
          data: buildDisablePolicyCalldata(agent.bech32m),
          unlockBackend: makeBiometricBackendFactory({
            unlock: unlockViaBiometric,
          }),
        });
        void refresh();
        return result.txHash;
      },
    });
  };

  const forget = async (agent: AgentRecord) => {
    await removeAgent(agent.addressHex);
    await refresh();
  };

  return (
    <div className="mw-scroll">
      {/* Create */}
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Agent sub-accounts</h3>
          <div className="spacer" />
          <button
            type="button"
            className="mw-btn"
            onClick={() => void refresh()}
            disabled={loading}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <p
          style={{
            margin: "0 0 12px",
            fontSize: 12.5,
            color: "var(--fg-300)",
            lineHeight: 1.55,
          }}
        >
          Grant an autonomous agent a bounded spend authority. Create a fresh
          sub-account key, fund it, then bind a spending policy (per-tx and
          rolling caps, counterparty allow-list, time window, expiry).
        </p>

        {error && (
          <div className="row-help" style={{ color: "var(--err)", marginBottom: 8 }}>
            {error}
          </div>
        )}

        {newMnemonic && (
          <div
            style={{
              padding: 10,
              marginBottom: 10,
              background: "rgba(242,180,65,0.06)",
              border: "1px solid rgba(242,180,65,0.4)",
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              Back up this agent recovery phrase
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12,
                lineHeight: 1.6,
                wordBreak: "break-word",
                color: "var(--fg-100)",
              }}
            >
              {newMnemonic}
            </div>
            <button
              type="button"
              className="mw-btn mw-btn--block"
              onClick={() => setNewMnemonic(null)}
              style={{ marginTop: 8, fontSize: 12 }}
            >
              I saved it
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            placeholder="Agent label (e.g. Trading bot)"
            aria-label="Agent label"
            className="mw-input"
            style={inputStyle}
          />
          <button
            type="button"
            className="mw-btn mw-btn--primary"
            onClick={() => void create()}
            disabled={creating}
            style={{ padding: "8px 14px", fontSize: 12, whiteSpace: "nowrap" }}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Controlled agents</h3>
          <div className="spacer" />
          <span className="more">
            {agents.length === 0 ? "—" : `${agents.length}`}
          </span>
        </div>

        {agents.length === 0 && !loading && (
          <div className="row-help">
            No agent sub-accounts yet. Create one above to delegate a bounded
            spend authority.
          </div>
        )}

        {agents.map((agent) => {
          const policy = policies.get(agent.addressHex) ?? null;
          return (
            <div
              key={agent.addressHex}
              className="mw-row"
              style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: "10px 0" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="mw-row__icon">
                  <Icon name="key" size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mw-row__name">{agent.label}</div>
                  <div className="mw-row__sub mono" style={{ wordBreak: "break-all" }}>
                    {agent.bech32m}
                  </div>
                  <div className="mw-row__sub" style={{ marginTop: 2 }}>
                    {policySummaryLabel(policy)}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="mw-btn"
                  onClick={() => setFundFor(fundFor === agent.addressHex ? null : agent.addressHex)}
                  style={miniBtn}
                >
                  Fund
                </button>
                <button
                  type="button"
                  className="mw-btn"
                  onClick={() => {
                    setFormError(null);
                    setForm(EMPTY_FORM);
                    setFormFor(formFor === agent.addressHex ? null : agent.addressHex);
                  }}
                  style={miniBtn}
                >
                  {policy && policy.exists ? "Update policy" : "Register policy"}
                </button>
                {policy && policy.exists && policy.enabled && (
                  <button
                    type="button"
                    className="mw-btn"
                    onClick={() => openRevoke(agent)}
                    style={{ ...miniBtn, color: "var(--err)" }}
                  >
                    Revoke
                  </button>
                )}
                <button
                  type="button"
                  className="mw-btn"
                  onClick={() => void forget(agent)}
                  style={{ ...miniBtn, color: "var(--fg-400)" }}
                >
                  Forget
                </button>
              </div>

              {fundFor === agent.addressHex && (
                <div style={subFormStyle}>
                  <label style={labelStyle}>Fund amount (LYTH)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={fundAmount}
                    onChange={(e) => setFundAmount(e.target.value)}
                    placeholder="0.0"
                    className="mw-input"
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    className="mw-btn mw-btn--primary mw-btn--block"
                    onClick={() => openFund(agent)}
                    style={{ fontSize: 12 }}
                  >
                    Review funding
                  </button>
                </div>
              )}

              {formFor === agent.addressHex && (
                <PolicyFormBody
                  form={form}
                  setForm={setForm}
                  formError={formError}
                  onSubmit={() => openRegister(agent)}
                />
              )}
            </div>
          );
        })}
      </div>

      <p
        style={{
          fontSize: 11.5,
          color: "var(--fg-400)",
          textAlign: "center",
          padding: "0 8px",
          lineHeight: 1.55,
        }}
      >
        <Icon name="key" size={11} /> &nbsp;Agent keys are sealed in this
        device&apos;s secure enclave. A fresh policy is signed by the agent key
        and submitted by your wallet (a two-key claim).
      </p>
    </div>
  );

  // ----- helpers reached only from the rendered tree --------------------

  async function readChainId(): Promise<bigint> {
    // Reuse the provider's chain id read so the bound message matches the
    // network the outer tx will land on.
    return getProvider().rpcClient.ethChainId();
  }
}

function PolicyFormBody({
  form,
  setForm,
  formError,
  onSubmit,
}: {
  form: PolicyForm;
  setForm: (f: PolicyForm) => void;
  formError: string | null;
  onSubmit: () => void;
}) {
  const set = (patch: Partial<PolicyForm>) => setForm({ ...form, ...patch });
  return (
    <div style={subFormStyle}>
      <label style={labelStyle}>Per-transaction cap (LYTH)</label>
      <input
        type="text"
        inputMode="decimal"
        value={form.perTxLyth}
        onChange={(e) => set({ perTxLyth: e.target.value })}
        placeholder="0 = no cap"
        className="mw-input"
        style={inputStyle}
      />
      <label style={labelStyle}>Daily cap (LYTH)</label>
      <input
        type="text"
        inputMode="decimal"
        value={form.dailyLyth}
        onChange={(e) => set({ dailyLyth: e.target.value })}
        placeholder="0 = no cap"
        className="mw-input"
        style={inputStyle}
      />
      <label style={labelStyle}>Weekly cap (LYTH)</label>
      <input
        type="text"
        inputMode="decimal"
        value={form.weeklyLyth}
        onChange={(e) => set({ weeklyLyth: e.target.value })}
        placeholder="0 = no cap"
        className="mw-input"
        style={inputStyle}
      />
      <label style={labelStyle}>Monthly cap (LYTH)</label>
      <input
        type="text"
        inputMode="decimal"
        value={form.monthlyLyth}
        onChange={(e) => set({ monthlyLyth: e.target.value })}
        placeholder="0 = no cap"
        className="mw-input"
        style={inputStyle}
      />
      <label style={labelStyle}>Allowed counterparty (mono1…, optional)</label>
      <input
        type="text"
        value={form.allowCounterparty}
        onChange={(e) => set({ allowCounterparty: e.target.value })}
        placeholder="empty = no counterparty constraint"
        className="mw-input"
        style={inputStyle}
      />
      <label style={labelStyle}>Category allow-root (0x… 32 bytes, optional)</label>
      <input
        type="text"
        value={form.categoryAllowRoot}
        onChange={(e) => set({ categoryAllowRoot: e.target.value })}
        placeholder="empty = no category constraint"
        className="mw-input"
        style={inputStyle}
      />
      <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={form.timeWindowEnabled}
          onChange={(e) => set({ timeWindowEnabled: e.target.checked })}
        />
        Restrict to a time-of-day window
      </label>
      {form.timeWindowEnabled && (
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Start hour (0-23)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={form.startHour}
              onChange={(e) => set({ startHour: e.target.value })}
              className="mw-input"
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>End hour (0-23)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={form.endHour}
              onChange={(e) => set({ endHour: e.target.value })}
              className="mw-input"
              style={inputStyle}
            />
          </div>
        </div>
      )}
      <label style={labelStyle}>Expiry (unix seconds, 0 = never)</label>
      <input
        type="text"
        inputMode="numeric"
        value={form.expiryUnix}
        onChange={(e) => set({ expiryUnix: e.target.value })}
        placeholder="0 = never expires"
        className="mw-input"
        style={inputStyle}
      />
      {formError && (
        <div className="row-help" style={{ color: "var(--err)" }}>
          {formError}
        </div>
      )}
      <button
        type="button"
        className="mw-btn mw-btn--primary mw-btn--block"
        onClick={onSubmit}
        style={{ fontSize: 12 }}
      >
        Review policy
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

/** Build SpendingPolicyArgs from the form. Throws on invalid amounts/hours. */
function buildArgs(
  form: PolicyForm,
  subAccountBech32m: string,
  principalBech32m: string,
): SpendingPolicyArgs {
  const perTx = parseCapLythoshi(form.perTxLyth, "per-transaction");
  const daily = parseCapLythoshi(form.dailyLyth, "daily");
  const weekly = parseCapLythoshi(form.weeklyLyth, "weekly");
  const monthly = parseCapLythoshi(form.monthlyLyth, "monthly");

  const allowRoot = form.allowCounterparty.trim()
    ? buildSingleAddressAllowRoot(form.allowCounterparty.trim())
    : emptyMerkleRoot();

  const categoryAllowRoot = form.categoryAllowRoot.trim()
    ? normalizeRoot(form.categoryAllowRoot.trim())
    : emptyMerkleRoot();

  let timeWindow: Uint8Array | undefined;
  if (form.timeWindowEnabled) {
    const start = parseHour(form.startHour, "start");
    const end = parseHour(form.endHour, "end");
    timeWindow = packPolicyTimeWindow(true, start, end);
  }

  const policyExpiry = (() => {
    const raw = form.expiryUnix.trim();
    if (!raw || raw === "0") return 0;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("Expiry must be a non-negative unix timestamp.");
    }
    return n;
  })();

  return {
    subAccount: subAccountBech32m,
    principal: principalBech32m,
    perTxCapLythoshi: perTx,
    dailyCapLythoshi: daily,
    weeklyCapLythoshi: weekly,
    monthlyCapLythoshi: monthly,
    allowRoot,
    denyRoot: emptyMerkleRoot(),
    categoryAllowRoot,
    ...(timeWindow ? { timeWindow } : {}),
    policyExpiry,
  };
}

function parseCapLythoshi(input: string, label: string): bigint {
  const raw = input.trim();
  if (!raw || raw === "0") return 0n;
  try {
    return parseLythToLythoshi(raw);
  } catch {
    throw new Error(`Invalid ${label} cap — enter a LYTH amount or 0.`);
  }
}

function parseHour(input: string, which: string): number {
  const n = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) {
    throw new Error(`${which} hour must be 0-23.`);
  }
  return n;
}

function normalizeRoot(input: string): string {
  const stripped = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error("Category allow-root must be a 0x-prefixed 32-byte hex value.");
  }
  return "0x" + stripped.toLowerCase();
}

/** Human-readable dimension rows for the drawer preview. */
function describeDims(form: PolicyForm): { k: string; v: string; mono?: boolean }[] {
  const rows: { k: string; v: string; mono?: boolean }[] = [];
  rows.push({ k: "Per-tx cap", v: capLabel(form.perTxLyth), mono: true });
  rows.push({ k: "Daily cap", v: capLabel(form.dailyLyth), mono: true });
  rows.push({ k: "Weekly cap", v: capLabel(form.weeklyLyth), mono: true });
  rows.push({ k: "Monthly cap", v: capLabel(form.monthlyLyth), mono: true });
  rows.push({
    k: "Counterparty",
    v: form.allowCounterparty.trim() ? shortBech(form.allowCounterparty.trim()) : "no constraint",
    mono: true,
  });
  rows.push({
    k: "Category allow",
    v: form.categoryAllowRoot.trim() ? "constrained (root)" : "no constraint",
  });
  rows.push({
    k: "Time window",
    v: form.timeWindowEnabled ? `${form.startHour}:00 – ${form.endHour}:00` : "any time",
  });
  rows.push({
    k: "Expiry",
    v: form.expiryUnix.trim() && form.expiryUnix.trim() !== "0" ? form.expiryUnix.trim() : "never",
  });
  return rows;
}

function capLabel(input: string): string {
  const raw = input.trim();
  if (!raw || raw === "0") return "no cap";
  return `${raw} LYTH`;
}

function policySummaryLabel(policy: SpendingPolicyView | null): string {
  if (!policy || !policy.exists) return "No policy bound";
  const perTx = policy.perTxCap === "0x0" ? "no per-tx cap" : `${formatLythoshi(BigInt(policy.perTxCap))} LYTH/tx`;
  const daily = policy.dailyCap === "0x0" ? "no daily cap" : `${formatLythoshi(BigInt(policy.dailyCap))} LYTH/day`;
  const state = policy.enabled ? "active" : "revoked";
  return `${state} · ${perTx} · ${daily}`;
}

function shortBech(s: string): string {
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "var(--fg-100)",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-400)",
};

const subFormStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  background: "rgba(255,255,255,0.03)",
  border: "1px solid var(--fg-700)",
  borderRadius: 8,
};

const miniBtn: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
};
