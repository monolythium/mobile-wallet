// Contacts picker — full-screen sheet shown from Send when the user
// taps the address-book affordance next to the Recipient field. Reads
// the local plugin-store via listContacts; client-side filter on name
// or bech32m address.
//
// Ports the browser-wallet ContactsPickerModal pattern (commit
// 30a1d8c) onto mobile's local-store contacts shape.

import { useEffect, useMemo, useState } from "react";
import { listContacts, type ContactRecord } from "../sdk/contacts";

interface Props {
  onSelect: (contact: ContactRecord) => void;
  onClose: () => void;
}

export function ContactsPickerSheet({ onSelect, onClose }: Props) {
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listContacts();
        if (!cancelled) setContacts(list);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.bech32m.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q),
    );
  }, [contacts, search]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose contact"
        onClick={(e) => e.stopPropagation()}
        className="mw-sheet"
        style={{
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: 16,
          background: "var(--bg-100)",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Choose contact
          </h3>
          <button
            className="mw-btn"
            onClick={onClose}
            style={{ padding: "5px 12px", fontSize: 12 }}
          >
            Cancel
          </button>
        </div>

        <input
          type="text"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          placeholder="Search by name or address"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%",
            padding: "10px 12px",
            fontSize: 14,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            color: "var(--fg-100)",
            outline: "none",
            marginBottom: 14,
          }}
        />

        {loading && (
          <div className="row-help">Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="row-help">
            {contacts.length === 0
              ? "No saved contacts. Add one from Settings → Contacts."
              : `No contact matches "${search.trim()}".`}
          </div>
        )}

        <div>
          {filtered.map((c) => (
            <button
              key={c.address}
              type="button"
              onClick={() => onSelect(c)}
              style={{
                display: "flex",
                width: "100%",
                gap: 12,
                padding: "12px 8px",
                background: "transparent",
                border: "none",
                borderBottom: "1px solid var(--fg-700)",
                color: "var(--fg-100)",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  minWidth: 36,
                  height: 36,
                  borderRadius: 18,
                  background: "rgba(124,127,255,0.10)",
                  color: "var(--fg-200)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {c.name.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</div>
                <div
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 11.5,
                    color: "var(--fg-400)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={c.bech32m}
                >
                  {c.bech32m}
                </div>
                {c.notes && (
                  <div style={{ fontSize: 11, color: "var(--fg-500)", marginTop: 2 }}>
                    {c.notes}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
