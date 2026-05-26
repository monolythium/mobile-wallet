// Contacts — full address book: list / add / rename / remove.
// Stored locally via @tauri-apps/plugin-store (see ../sdk/contacts.ts).

import { useCallback, useEffect, useState } from "react";
import {
  ContactValidationError,
  MAX_NAME_LEN,
  MAX_NOTE_LEN,
  addContact,
  listContacts,
  removeContact,
  renameContact,
  type ContactRecord,
} from "../sdk/contacts";

interface Props {
  /** Optional close — when rendered as a sub-screen (Settings). */
  onClose?: () => void;
}

type Mode = "list" | "add";

export function Contacts({ onClose }: Props) {
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [mode, setMode] = useState<Mode>("list");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setContacts(await listContacts());
      setError(null);
    } catch (cause) {
      setError((cause as Error)?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mw-scroll">
      {mode === "add" ? (
        <AddContactForm
          onCancel={() => setMode("list")}
          onAdded={async () => {
            await refresh();
            setMode("list");
          }}
        />
      ) : (
        <>
          <div className="mw-card">
            <div className="mw-card__head">
              <h3>Contacts</h3>
              <div className="spacer" />
              <button
                type="button"
                className="mw-btn mw-btn--primary"
                onClick={() => setMode("add")}
                style={{ padding: "6px 12px", fontSize: 12 }}
              >
                Add
              </button>
            </div>

            {error && (
              <div className="row-help" style={{ color: "var(--err)" }}>
                {error}
              </div>
            )}

            {loading && contacts.length === 0 && (
              <div className="row-help">Loading…</div>
            )}

            {!loading && contacts.length === 0 && !error && (
              <div className="row-help">
                No saved contacts. Tap Add to save a frequent recipient.
              </div>
            )}

            {contacts.map((c) => (
              <ContactListRow
                key={c.address}
                contact={c}
                onChanged={() => void refresh()}
              />
            ))}
          </div>

          {onClose && (
            <button
              className="mw-btn mw-btn--block"
              onClick={onClose}
              style={{ marginTop: 14 }}
            >
              Close
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ContactListRow({
  contact,
  onChanged,
}: {
  contact: ContactRecord;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(contact.name);
  const [error, setError] = useState<string | null>(null);

  const onRemove = async () => {
    setError(null);
    try {
      await removeContact(contact.address);
      onChanged();
    } catch (cause) {
      setError((cause as Error)?.message ?? "remove failed");
      setConfirming(false);
    }
  };

  const onRename = async () => {
    setError(null);
    try {
      await renameContact(contact.address, draftName);
      setRenaming(false);
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof ContactValidationError
          ? cause.message
          : (cause as Error)?.message ?? "rename failed",
      );
    }
  };

  return (
    <div
      className="mw-row"
      style={{ flexDirection: "column", alignItems: "stretch", gap: 6, padding: "10px 0" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="mw-row__icon">{contact.name.slice(0, 2).toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <input
              type="text"
              autoFocus
              value={draftName}
              maxLength={MAX_NAME_LEN}
              onChange={(e) => setDraftName(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 8px",
                fontSize: 14,
                fontWeight: 500,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                color: "var(--fg-100)",
                outline: "none",
              }}
            />
          ) : (
            <div className="mw-row__name">{contact.name}</div>
          )}
          <div
            className="mw-row__sub"
            style={{
              fontFamily: "var(--f-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={contact.bech32m}
          >
            {contact.bech32m}
          </div>
          {contact.notes && (
            <div className="mw-row__sub" style={{ marginTop: 4 }}>
              {contact.notes}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="row-help" style={{ color: "var(--err)" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        {renaming ? (
          <>
            <button
              className="mw-btn"
              onClick={() => {
                setRenaming(false);
                setDraftName(contact.name);
              }}
              style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
            >
              Cancel
            </button>
            <button
              className="mw-btn mw-btn--primary"
              onClick={() => void onRename()}
              style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
            >
              Save
            </button>
          </>
        ) : confirming ? (
          <>
            <button
              className="mw-btn"
              onClick={() => setConfirming(false)}
              style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
            >
              Cancel
            </button>
            <button
              className="mw-btn"
              onClick={() => void onRemove()}
              style={{
                flex: 1,
                padding: "6px 10px",
                fontSize: 12,
                color: "var(--err)",
                borderColor: "var(--err)",
              }}
            >
              Confirm remove
            </button>
          </>
        ) : (
          <>
            <button
              className="mw-btn"
              onClick={() => setRenaming(true)}
              style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
            >
              Rename
            </button>
            <button
              className="mw-btn"
              onClick={() => setConfirming(true)}
              style={{
                flex: 1,
                padding: "6px 10px",
                fontSize: 12,
                color: "var(--err)",
              }}
            >
              Remove
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AddContactForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await addContact({ name, address, notes });
      await onAdded();
    } catch (cause) {
      setError(
        cause instanceof ContactValidationError
          ? cause.message
          : (cause as Error)?.message ?? "save failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mw-card">
        <div className="mw-card__head">
          <h3>Add contact</h3>
        </div>

        <label style={fieldLabel}>Name</label>
        <input
          type="text"
          autoFocus
          maxLength={MAX_NAME_LEN}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alice"
          style={inputStyle}
        />

        <label style={{ ...fieldLabel, marginTop: 12 }}>
          Typed address
        </label>
        <input
          type="text"
          autoCapitalize="none"
          spellCheck={false}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="mono1…"
          style={inputStyle}
        />

        <label style={{ ...fieldLabel, marginTop: 12 }}>
          Note (optional)
        </label>
        <input
          type="text"
          maxLength={MAX_NOTE_LEN}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Up to 256 characters"
          style={inputStyle}
        />

        {error && (
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--err)" }}>
            {error}
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="mw-btn" onClick={onCancel} style={{ flex: 1 }}>
          Cancel
        </button>
        <button
          className="mw-btn mw-btn--primary mw-btn--block"
          onClick={() => void onSave()}
          disabled={busy || !name.trim() || !address.trim()}
          style={{ flex: 1 }}
        >
          {busy ? "Saving…" : "Save contact"}
        </button>
      </div>
    </>
  );
}

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-400)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: 14,
  fontFamily: "var(--f-mono)",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  color: "var(--fg-100)",
  outline: "none",
};
