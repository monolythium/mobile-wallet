// Clipboard helper for security-sensitive material (24-word PQM-1
// recovery phrase). Copies to the OS clipboard, then schedules a best-
// effort wipe after a configurable timeout. The wipe is best-effort
// because navigator.clipboard.readText requires user permission and
// may reject; if it fails we still blindly call writeText("") so the
// clipboard is at least cleared even though we can't verify it still
// held our copy.
//
// Only one in-flight clear-timer is tracked. Calling copyWithAutoClear
// again while a previous timer is pending resets the timer.

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let lastCopiedText: string | null = null;

export async function copyWithAutoClear(
  text: string,
  clearAfterMs: number = 30_000,
): Promise<void> {
  cancelClipboardAutoClear();
  await navigator.clipboard.writeText(text);
  lastCopiedText = text;
  clearTimer = setTimeout(() => {
    void (async () => {
      try {
        let currentMatchesOurs = true;
        try {
          const current = await navigator.clipboard.readText();
          currentMatchesOurs = current === lastCopiedText;
        } catch {
          // readText denied — assume our text is still there.
        }
        if (currentMatchesOurs) {
          try {
            await navigator.clipboard.writeText("");
          } catch {
            // writeText denied during clear — nothing we can do.
          }
        }
      } finally {
        clearTimer = null;
        lastCopiedText = null;
      }
    })();
  }, clearAfterMs);
}

export function cancelClipboardAutoClear(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
    lastCopiedText = null;
  }
}

export function formatPhraseForClipboard(words: readonly string[]): string {
  return words.map((word, i) => `${i + 1}.${word}`).join(" ");
}
