// ③ Audit screen helpers (Architecture 10 감사 화면): the tx hash format is checked before any request.

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export type TxInput = { ok: true; tx: string } | { ok: false; reason: "empty" | "invalid" };

export function normalizeTxInput(raw: string): TxInput {
    const tx = raw.trim();
    if (tx === "") return { ok: false, reason: "empty" };
    return TX_HASH.test(tx) ? { ok: true, tx } : { ok: false, reason: "invalid" };
}

/** hashMatch of an audit item → badge text and tone (badge-ok / badge-blocked / badge-pending). */
export function hashVerdict(hashMatch: boolean | null): { label: string; tone: "ok" | "blocked" | "pending" } {
    if (hashMatch === null) return { label: "No local evidence", tone: "pending" };
    return hashMatch ? { label: "Hash match", tone: "ok" } : { label: "Hash MISMATCH", tone: "blocked" };
}
