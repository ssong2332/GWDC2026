import type { ActivityItemDto } from "@/app/api/_lib/dto";

// Dashboard derivations (PRD 화면 ②): the approval inbox and the budget summary.

export type { ActivityItemDto };

const key = (id: string | null) => (id ?? "").toLowerCase();

/** Pending requests with no Approved/Rejected event yet (the 승인 대기함), in chain order. */
export function openPendings(items: ActivityItemDto[]): ActivityItemDto[] {
    const settled = new Set(items.filter((i) => i.kind === "approved" || i.kind === "rejected").map((i) => key(i.requestId)));
    return items.filter((i) => i.kind === "pending" && !settled.has(key(i.requestId)));
}

export function newestFirst(items: ActivityItemDto[]): ActivityItemDto[] {
    return items.map((item, index) => ({ item, index })).sort((a, b) => b.item.blockTimestamp - a.item.blockTimestamp || b.index - a.index).map((x) => x.item);
}

/** remaining = budget − spent − reserved (never below zero). */
export function budgetView(s: { budget: string; spent: string; reserved: string }) {
    const budget = BigInt(s.budget);
    const spent = BigInt(s.spent);
    const reserved = BigInt(s.reserved);
    const left = budget - spent - reserved;
    return { budget, spent, reserved, remaining: left > 0n ? left : 0n };
}
