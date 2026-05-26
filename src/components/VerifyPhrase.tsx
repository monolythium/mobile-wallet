import { useMemo, useState } from "react";
import { wordlist as bip39English } from "@scure/bip39/wordlists/english.js";

interface VerifyPhraseProps {
  mnemonic: string;
  onVerified: () => void;
  /** Optional back affordance. Onboarding intentionally omits this so the
   *  user can't bypass verification by stepping back. */
  onBack?: () => void;
}

// 6 hidden positions × ~11-word bank ≈ 10^6 random-guess hit rate.
const HIDDEN_COUNT = 6;
const DISTRACTOR_COUNT = 5;

function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function pickIndices(total: number, n: number): number[] {
  const set = new Set<number>();
  while (set.size < n && set.size < total) {
    set.add(Math.floor(Math.random() * total));
  }
  return Array.from(set).sort((a, b) => a - b);
}

function pickDistractors(count: number, exclude: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const used = new Set(exclude);
  for (let attempts = 0; attempts < 200 && out.length < count; attempts++) {
    const idx = Math.floor(Math.random() * bip39English.length);
    const w = bip39English[idx];
    if (!w || used.has(w)) continue;
    used.add(w);
    out.push(w);
  }
  return out;
}

interface Slot {
  index: number;
  filled: string | null;
}

interface Challenge {
  slots: Slot[];
  bank: string[];
  hiddenIdxSet: ReadonlySet<number>;
}

function buildChallenge(words: readonly string[]): Challenge {
  const hiddenIdx = pickIndices(words.length, HIDDEN_COUNT);
  const hiddenIdxSet = new Set(hiddenIdx);
  const hiddenWords = hiddenIdx.map((i) => words[i]!);
  const distractors = pickDistractors(DISTRACTOR_COUNT, new Set(words));
  const bank = shuffle([...hiddenWords, ...distractors]);
  const slots: Slot[] = words.map((word, i) => ({
    index: i,
    filled: hiddenIdxSet.has(i) ? null : word,
  }));
  return { slots, bank, hiddenIdxSet };
}

/**
 * Mobile fill-in-the-blanks recovery verifier. Hides 6 random positions
 * and asks the user to drop in the correct words from a bank of 6 correct
 * + 5 BIP-39 distractors. "Try again" rebuilds with a fresh set of
 * hidden positions so position memorisation doesn't help.
 */
export function VerifyPhrase({
  mnemonic,
  onVerified,
  onBack,
}: VerifyPhraseProps) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  const [challenge, setChallenge] = useState<Challenge>(() => buildChallenge(words));
  const [slots, setSlots] = useState<Slot[]>(challenge.slots);
  const [bank, setBank] = useState<string[]>(challenge.bank);
  const [attempted, setAttempted] = useState(false);

  const handlePickFromBank = (word: string) => {
    const firstEmpty = slots.findIndex(
      (s) => s.filled === null && challenge.hiddenIdxSet.has(s.index),
    );
    if (firstEmpty === -1) return;
    setSlots((prev) =>
      prev.map((s, i) => (i === firstEmpty ? { ...s, filled: word } : s)),
    );
    setBank((prev) => prev.filter((w) => w !== word));
  };

  const handleResetSlot = (slotIdx: number) => {
    const slot = slots[slotIdx];
    if (!slot || slot.filled === null) return;
    if (!challenge.hiddenIdxSet.has(slot.index)) return;
    const removed = slot.filled;
    setSlots((prev) =>
      prev.map((s, i) => (i === slotIdx ? { ...s, filled: null } : s)),
    );
    setBank((prev) => [...prev, removed]);
  };

  const allFilled = slots.every((s) => s.filled !== null);
  const allCorrect =
    allFilled && slots.every((s) => s.filled === words[s.index]);

  const handleContinue = () => {
    if (!allFilled) return;
    if (allCorrect) {
      onVerified();
      return;
    }
    setAttempted(true);
  };

  const handleTryAgain = () => {
    const fresh = buildChallenge(words);
    setChallenge(fresh);
    setSlots(fresh.slots);
    setBank(fresh.bank);
    setAttempted(false);
  };

  if (attempted && !allCorrect) {
    return (
      <div className="mw-card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 12 }} aria-hidden="true">
          ⚠️
        </div>
        <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600 }}>
          Not quite right
        </h2>
        <p
          style={{
            margin: "0 0 18px",
            fontSize: 13,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          Double-check your 24-word PQM-1 recovery phrase and try again.
          We&apos;ll show a fresh set of positions so the attempt is fair.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {onBack ? (
            <button className="mw-btn" onClick={onBack} style={{ flex: 1 }}>
              Back
            </button>
          ) : null}
          <button
            className="mw-btn mw-btn--primary mw-btn--block"
            onClick={handleTryAgain}
            style={{ flex: 1 }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Verify recovery phrase</h3>
        </div>
        <p
          style={{
            margin: "0 0 14px",
            fontSize: 13,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          Select the missing words in the correct order. Blurred slots are
          already filled — tap a placed word to return it to the bank.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 6,
          }}
        >
          {slots.map((slot, slotIdx) => {
            const isHidden = challenge.hiddenIdxSet.has(slot.index);
            const isEmpty = slot.filled === null;
            const borderColor = isHidden ? "var(--gold)" : "var(--fg-700)";
            const background = isEmpty && isHidden
              ? "rgba(242,180,65,0.04)"
              : isHidden
                ? "rgba(242,180,65,0.10)"
                : "rgba(0,0,0,0.20)";

            return (
              <button
                key={slot.index}
                type="button"
                disabled={!isHidden || isEmpty}
                onClick={() => handleResetSlot(slotIdx)}
                aria-label={
                  isHidden && isEmpty
                    ? `Word ${slot.index + 1}, empty`
                    : isHidden
                      ? `Word ${slot.index + 1}, ${slot.filled} (tap to remove)`
                      : `Word ${slot.index + 1}, pre-filled (hidden)`
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "9px 10px",
                  borderRadius: 8,
                  fontFamily: "var(--f-mono)",
                  fontSize: 12,
                  border: `1px ${isEmpty && isHidden ? "dashed" : "solid"} ${borderColor}`,
                  background,
                  color: isEmpty
                    ? "var(--fg-500)"
                    : isHidden
                      ? "var(--fg-100)"
                      : "var(--fg-300)",
                  textAlign: "left",
                  cursor: isHidden && !isEmpty ? "pointer" : "default",
                  minHeight: 36,
                  transition: "all 150ms var(--e-out)",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--fg-500)",
                    minWidth: 18,
                  }}
                >
                  {slot.index + 1}.
                </span>
                <span
                  style={{
                    flex: 1,
                    ...(!isHidden && !isEmpty
                      ? {
                          filter: "blur(5px)",
                          userSelect: "none" as const,
                        }
                      : {}),
                  }}
                >
                  {slot.filled ?? " "}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mw-card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            justifyContent: "center",
            minHeight: 56,
            alignItems: "center",
          }}
        >
          {bank.length === 0 ? (
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                color: "var(--fg-500)",
              }}
            >
              All words placed
            </div>
          ) : (
            bank.map((word) => (
              <button
                key={word}
                type="button"
                onClick={() => handlePickFromBank(word)}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(242,180,65,0.4)",
                  background: "rgba(242,180,65,0.08)",
                  color: "var(--gold)",
                  fontFamily: "var(--f-mono)",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {word}
              </button>
            ))
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {onBack ? (
          <button className="mw-btn" onClick={onBack} style={{ flex: 1 }}>
            Back
          </button>
        ) : null}
        <button
          className="mw-btn mw-btn--primary mw-btn--block"
          disabled={!allFilled}
          onClick={handleContinue}
          style={{ flex: 1, opacity: allFilled ? 1 : 0.45 }}
        >
          Continue
        </button>
      </div>
    </>
  );
}
