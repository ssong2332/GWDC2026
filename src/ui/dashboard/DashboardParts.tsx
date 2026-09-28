"use client";

import { useEffect, useRef } from "react";
import type { ActivityItemDto, ReceiptResponse, VaultStateResponse } from "@/app/api/_lib/dto";
import type { Hex } from "@/core/domain/types";
import { KST_OFFSET_SECONDS } from "@/config/constants";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { AsyncView } from "../components/AsyncView";
import { Krw } from "../components/Krw";
import { ReasonBadge } from "../components/ReasonBadge";
import { TxHashLink } from "../components/TxHashLink";
import { useApi } from "../hooks/useApi";
import { budgetView } from "./activity";

// Dashboard building blocks (Architecture 10 대시보드 구성): BudgetSummary, PendingInbox, ActivityList, ReceiptDialog.

const KIND_LABEL: Record<ActivityItemDto["kind"], string> = {
    executed: "Paid",
    blocked: "Blocked",
    pending: "Waiting for approval",
    approved: "Approved",
    rejected: "Rejected",
    paused: "Vault paused",
    unpaused: "Vault resumed",
    policy_set: "Policy registered",
};

const JUDGMENT_LABEL: Record<string, string> = {
    match: "AI: fits the purpose",
    mismatch: "AI: does not fit the purpose",
    invalid_output: "AI: invalid output (sent for review)",
    error: "AI: call failed (sent for review)",
};

const merchantName = (id: string | null) => (id === null ? "—" : (MERCHANT_REGISTRY.find((m) => m.id === id)?.displayName ?? id));
export const kstTime = (unix: number) =>
    `${new Date((unix + KST_OFFSET_SECONDS) * 1000).toISOString().replace("T", " ").slice(0, 19)} KST`;

export function BudgetSummary({ v }: { v: VaultStateResponse }) {
    const b = budgetView(v.state);
    const s = v.state;
    return (
        <section className="card" aria-label="Budget">
            <div className="row space-between">
                <h2>Budget</h2>
                {s.paused ? <span className="badge badge-blocked">Paused</span> : <span className="badge badge-ok">Active</span>}
            </div>
            <dl className="stats">
                <div>
                    <dt>Remaining</dt>
                    <dd className="big">
                        <Krw value={b.remaining} />
                    </dd>
                </div>
                <div>
                    <dt>Total budget</dt>
                    <dd>
                        <Krw value={b.budget} />
                    </dd>
                </div>
                <div>
                    <dt>Spent (incl. fees)</dt>
                    <dd>
                        <Krw value={b.spent} />
                    </dd>
                </div>
                <div>
                    <dt>Reserved by pending</dt>
                    <dd>
                        <Krw value={b.reserved} />
                    </dd>
                </div>
                <div>
                    <dt>Platform fee</dt>
                    <dd>{(v.feeBps / 100).toFixed(2)}%</dd>
                </div>
                <div>
                    <dt>Ask above</dt>
                    <dd>
                        <Krw value={s.approvalThreshold} />
                    </dd>
                </div>
                <div>
                    <dt>Expires</dt>
                    <dd>{kstTime(s.expiresAt)}</dd>
                </div>
                <div>
                    <dt>Burst limit</dt>
                    <dd>
                        {s.maxPerMinute}/min · {s.maxPerDay}/day
                    </dd>
                </div>
            </dl>
            <p className="muted small">
                Policy v{s.policyVersion} · merchants: {s.merchants.map((a) => MERCHANT_REGISTRY.find((m) => m.address.toLowerCase() === a.toLowerCase())?.displayName ?? a).join(", ")} · vault
                balance <Krw value={s.vaultBalance} /> (mKRW test token, 1 mKRW = ₩1)
            </p>
        </section>
    );
}

export function PendingRow({ item, onApprove, onReject, disabled }: { item: ActivityItemDto; onApprove: () => void; onReject: () => void; disabled: boolean }) {
    return (
        <li className="pending-item">
            <div>
                <strong>{merchantName(item.merchantId)}</strong> · <Krw value={item.amount} /> <span className="muted">(+ fee <Krw value={item.fee} />)</span>
                <div>
                    <ReasonBadge kind="pending" reason={null} flags={item.flags} />
                    {item.judgmentStatus ? <span className="muted small"> {JUDGMENT_LABEL[item.judgmentStatus] ?? item.judgmentStatus}</span> : null}
                </div>
                <span className="muted small">
                    {kstTime(item.blockTimestamp)} · request {item.requestId?.slice(0, 10)}…
                </span>
            </div>
            <div className="row">
                <button type="button" onClick={onApprove} disabled={disabled}>
                    Approve
                </button>
                <button type="button" className="btn-danger-outline" onClick={onReject} disabled={disabled}>
                    Reject
                </button>
            </div>
        </li>
    );
}

export function ActivityList({ items, explorerTxUrl, onReceipt }: { items: ActivityItemDto[]; explorerTxUrl: string | null; onReceipt: (requestId: Hex) => void }) {
    return (
        <div className="table-wrap">
            <table>
                <caption className="sr-only">Vault activity, newest first</caption>
                <thead>
                    <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Event</th>
                        <th scope="col">Merchant</th>
                        <th scope="col" className="num">
                            Amount
                        </th>
                        <th scope="col" className="num">
                            Fee
                        </th>
                        <th scope="col">Details</th>
                        <th scope="col">Tx</th>
                        <th scope="col">
                            <span className="sr-only">Receipt</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {items.map((i) => (
                        <tr key={`${i.txHash}:${i.kind}:${i.requestId ?? ""}`}>
                            <td className="nowrap">{kstTime(i.blockTimestamp)}</td>
                            <td>
                                <span className={`kind kind-${i.kind}`}>{KIND_LABEL[i.kind]}</span>
                            </td>
                            <td>{merchantName(i.merchantId)}</td>
                            <td className="num">
                                <Krw value={i.amount} />
                            </td>
                            <td className="num">
                                <Krw value={i.fee} />
                            </td>
                            <td>
                                <ReasonBadge kind={i.kind} reason={i.reason} flags={i.flags} />
                                {i.judgmentStatus && i.kind !== "approved" ? <span className="muted small"> {JUDGMENT_LABEL[i.judgmentStatus] ?? i.judgmentStatus}</span> : null}
                            </td>
                            <td>
                                <TxHashLink hash={i.txHash} explorerTxUrl={explorerTxUrl} />
                            </td>
                            <td>
                                {i.kind === "executed" && i.requestId ? (
                                    <button type="button" className="btn-link" onClick={() => onReceipt(i.requestId!)}>
                                        Receipt
                                    </button>
                                ) : null}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const RECEIPT_JUDGMENT: Record<string, string> = {
    ...JUDGMENT_LABEL,
    not_judged: "No AI judgment (decided by the rule pre-check)",
    no_local_evidence: "Not available — the request evidence is not stored in this server's database",
};

/** Modal receipt (F-10): amount, fee, merchant, tx hash, evidence hash, Kiln judgment summary. */
export function ReceiptDialog({ requestId, explorerTxUrl, onClose }: { requestId: Hex | null; explorerTxUrl: string | null; onClose: () => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    const receipt = useApi<ReceiptResponse>(requestId ? `/api/receipts/${requestId}` : null);
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (requestId && !d.open) d.showModal();
        if (!requestId && d.open) d.close();
    }, [requestId]);
    return (
        <dialog ref={ref} className="dialog" aria-labelledby="receipt-title" onClose={onClose}>
            <h2 id="receipt-title">Receipt</h2>
            {requestId === null ? null : (
                <AsyncView state={receipt} loadingLabel="Loading receipt…">
                    {({ receipt: r }) => (
                        <dl className="receipt">
                            <dt>Amount</dt>
                            <dd>
                                <Krw value={r.amount} />
                            </dd>
                            <dt>Fee</dt>
                            <dd>
                                <Krw value={r.fee} />
                            </dd>
                            <dt>Merchant</dt>
                            <dd>
                                {r.merchant.name} <code className="hash">{r.merchant.address}</code>
                            </dd>
                            <dt>Transaction</dt>
                            <dd>
                                <TxHashLink hash={r.txHash} explorerTxUrl={explorerTxUrl} full />
                            </dd>
                            <dt>Evidence hash</dt>
                            <dd>
                                <code className="hash">{r.evidenceHash}</code>
                            </dd>
                            <dt>AI judgment</dt>
                            <dd>
                                {RECEIPT_JUDGMENT[r.judgmentSummary.status] ?? r.judgmentSummary.status}
                                {r.judgmentSummary.provider === "fake" ? " (simulated Kiln)" : ""}
                                {r.judgmentSummary.reason ? <span className="quote">{r.judgmentSummary.reason}</span> : null}
                            </dd>
                            <dt>Paid</dt>
                            <dd>
                                {kstTime(r.blockTimestamp)}
                                {r.viaApproval ? (
                                    <>
                                        {" "}
                                        · approved by <code className="hash">{r.approver}</code>
                                    </>
                                ) : (
                                    " · within the policy, no approval needed"
                                )}
                            </dd>
                        </dl>
                    )}
                </AsyncView>
            )}
            <form method="dialog">
                <button type="submit" className="btn-secondary">
                    Close
                </button>
            </form>
        </dialog>
    );
}
