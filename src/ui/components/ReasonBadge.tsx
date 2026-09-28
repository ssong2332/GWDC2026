import { blockReasonLabel, pendingFlagLabels } from "@/core/domain/reasons";

// Reason / flag codes → labels shared with the contract (src/core/domain/reasons.ts).

export function ReasonBadge({ kind, reason, flags }: { kind: string; reason: number | null; flags: number | null }) {
    if (kind === "blocked" && reason !== null) return <span className="badge badge-blocked">{blockReasonLabel(reason)}</span>;
    if (kind === "pending" && flags !== null)
        return (
            <>
                {pendingFlagLabels(flags).map((label) => (
                    <span key={label} className="badge badge-pending">
                        {label}
                    </span>
                ))}
            </>
        );
    return null;
}
