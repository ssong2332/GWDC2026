"use client";

import { PendingFlag } from "@/core/domain/reasons";
import { useI18n } from "../i18n/LocaleProvider";
import { labelFor } from "../i18n/messages";

// Reason / flag codes (shared with the contract, src/core/domain/reasons.ts) → labels in the selected language
// (T-17, D-41: m.reasons / m.flags instead of the English labels in reasons.ts, which stay for the API and CLI).

const FLAG_BITS = [PendingFlag.OVER_THRESHOLD, PendingFlag.AGENT_REVIEW_REQUEST];

export function ReasonBadge({ kind, reason, flags }: { kind: string; reason: number | null; flags: number | null }) {
    const { m } = useI18n();
    if (kind === "blocked" && reason !== null) return <span className="badge badge-blocked">{labelFor(m.reasons, reason) ?? m.reasons.unknown({ code: reason })}</span>;
    if (kind === "pending" && flags !== null)
        return (
            <>
                {FLAG_BITS.filter((bit) => (flags & bit) !== 0).map((bit) => (
                    <span key={bit} className="badge badge-pending">
                        {m.flags[bit]}
                    </span>
                ))}
            </>
        );
    return null;
}
