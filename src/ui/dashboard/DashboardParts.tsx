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
import { useI18n } from "../i18n/LocaleProvider";
import { labelFor } from "../i18n/messages";
import { budgetView } from "./activity";

// Dashboard building blocks (Architecture 10 대시보드 구성): BudgetSummary, PendingInbox, ActivityList, ReceiptDialog.
// T-17: labels from the selected dictionary (m.activityKinds, m.judgment, m.dashboard); merchant names, amounts, times,
// hashes and the Kiln judgment reason are data and are shown as they are (F-17 ⑦⑨, D-42).

const merchantName = (id: string | null) => (id === null ? "—" : (MERCHANT_REGISTRY.find((m) => m.id === id)?.displayName ?? id));
export const kstTime = (unix: number) =>
    `${new Date((unix + KST_OFFSET_SECONDS) * 1000).toISOString().replace("T", " ").slice(0, 19)} KST`;

export function BudgetSummary({ v }: { v: VaultStateResponse }) {
    const t = useI18n().m.dashboard.budget;
    const b = budgetView(v.state);
    const s = v.state;
    return (
        <section className="card" aria-label={t.title}>
            <div className="row space-between">
                <h2>{t.title}</h2>
                {s.paused ? <span className="badge badge-blocked">{t.paused}</span> : <span className="badge badge-ok">{t.active}</span>}
            </div>
            <dl className="stats">
                <div>
                    <dt>{t.remaining}</dt>
                    <dd className="big">
                        <Krw value={b.remaining} />
                    </dd>
                </div>
                <div>
                    <dt>{t.total}</dt>
                    <dd>
                        <Krw value={b.budget} />
                    </dd>
                </div>
                <div>
                    <dt>{t.spent}</dt>
                    <dd>
                        <Krw value={b.spent} />
                    </dd>
                </div>
                <div>
                    <dt>{t.reserved}</dt>
                    <dd>
                        <Krw value={b.reserved} />
                    </dd>
                </div>
                <div>
                    <dt>{t.fee}</dt>
                    <dd>{(v.feeBps / 100).toFixed(2)}%</dd>
                </div>
                <div>
                    <dt>{t.askAbove}</dt>
                    <dd>
                        <Krw value={s.approvalThreshold} />
                    </dd>
                </div>
                <div>
                    <dt>{t.expires}</dt>
                    <dd>{kstTime(s.expiresAt)}</dd>
                </div>
                <div>
                    <dt>{t.burst}</dt>
                    <dd>
                        {s.maxPerMinute}
                        {t.perMinute} · {s.maxPerDay}
                        {t.perDay}
                    </dd>
                </div>
            </dl>
            <p className="muted small">
                {t.policy({ version: Number(s.policyVersion) })} · {t.merchants}: {s.merchants.map((a) => MERCHANT_REGISTRY.find((m) => m.address.toLowerCase() === a.toLowerCase())?.displayName ?? a).join(", ")} ·{" "}
                {t.vaultBalance} <Krw value={s.vaultBalance} /> {t.tokenNote}
            </p>
        </section>
    );
}

export function PendingRow({ item, onApprove, onReject, disabled }: { item: ActivityItemDto; onApprove: () => void; onReject: () => void; disabled: boolean }) {
    const { m } = useI18n();
    const t = m.dashboard.pending;
    return (
        <li className="pending-item">
            <div>
                <strong>{merchantName(item.merchantId)}</strong> · <Krw value={item.amount} /> <span className="muted">
                    ({t.plusFee} <Krw value={item.fee} />)
                </span>
                <div>
                    <ReasonBadge kind="pending" reason={null} flags={item.flags} />
                    {item.judgmentStatus ? <span className="muted small"> {labelFor(m.judgment, item.judgmentStatus) ?? item.judgmentStatus}</span> : null}
                </div>
                <span className="muted small">
                    {kstTime(item.blockTimestamp)} · {t.request} {item.requestId?.slice(0, 10)}…
                </span>
            </div>
            <div className="row">
                <button type="button" onClick={onApprove} disabled={disabled}>
                    {t.approve}
                </button>
                <button type="button" className="btn-danger-outline" onClick={onReject} disabled={disabled}>
                    {t.reject}
                </button>
            </div>
        </li>
    );
}

export function ActivityList({ items, explorerTxUrl, onReceipt }: { items: ActivityItemDto[]; explorerTxUrl: string | null; onReceipt: (requestId: Hex) => void }) {
    const { m } = useI18n();
    const t = m.dashboard.table;
    return (
        <div className="table-wrap">
            <table>
                <caption className="sr-only">{t.caption}</caption>
                <thead>
                    <tr>
                        <th scope="col">{t.time}</th>
                        <th scope="col">{t.event}</th>
                        <th scope="col">{t.merchant}</th>
                        <th scope="col" className="num">
                            {t.amount}
                        </th>
                        <th scope="col" className="num">
                            {t.fee}
                        </th>
                        <th scope="col">{t.details}</th>
                        <th scope="col">{t.tx}</th>
                        <th scope="col">
                            <span className="sr-only">{t.receipt}</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {items.map((i) => (
                        <tr key={`${i.txHash}:${i.kind}:${i.requestId ?? ""}`}>
                            <td className="nowrap">{kstTime(i.blockTimestamp)}</td>
                            <td>
                                <span className={`kind kind-${i.kind}`}>{labelFor(m.activityKinds, i.kind) ?? i.kind}</span>
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
                                {i.judgmentStatus && i.kind !== "approved" ? <span className="muted small"> {labelFor(m.judgment, i.judgmentStatus) ?? i.judgmentStatus}</span> : null}
                            </td>
                            <td>
                                <TxHashLink hash={i.txHash} explorerTxUrl={explorerTxUrl} />
                            </td>
                            <td>
                                {i.kind === "executed" && i.requestId ? (
                                    <button type="button" className="btn-link" onClick={() => onReceipt(i.requestId!)}>
                                        {t.receipt}
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

/** Modal receipt (F-10): amount, fee, merchant, tx hash, evidence hash, Kiln judgment summary. */
export function ReceiptDialog({ requestId, explorerTxUrl, onClose }: { requestId: Hex | null; explorerTxUrl: string | null; onClose: () => void }) {
    const { m } = useI18n();
    const t = m.dashboard.receipt;
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
            <h2 id="receipt-title">{t.title}</h2>
            {requestId === null ? null : (
                <AsyncView state={receipt} loadingLabel={t.loading}>
                    {({ receipt: r }) => (
                        <dl className="receipt">
                            <dt>{t.amount}</dt>
                            <dd>
                                <Krw value={r.amount} />
                            </dd>
                            <dt>{t.fee}</dt>
                            <dd>
                                <Krw value={r.fee} />
                            </dd>
                            <dt>{t.merchant}</dt>
                            <dd>
                                {r.merchant.name} <code className="hash">{r.merchant.address}</code>
                            </dd>
                            <dt>{t.transaction}</dt>
                            <dd>
                                <TxHashLink hash={r.txHash} explorerTxUrl={explorerTxUrl} full />
                            </dd>
                            <dt>{t.evidenceHash}</dt>
                            <dd>
                                <code className="hash">{r.evidenceHash}</code>
                            </dd>
                            <dt>{t.aiJudgment}</dt>
                            <dd>
                                {labelFor(m.judgment, r.judgmentSummary.status) ?? r.judgmentSummary.status}
                                {r.judgmentSummary.provider === "fake" ? t.simulated : ""}
                                {r.judgmentSummary.reason ? <span className="quote">{r.judgmentSummary.reason}</span> : null}
                            </dd>
                            <dt>{t.paid}</dt>
                            <dd>
                                {kstTime(r.blockTimestamp)}
                                {r.viaApproval ? (
                                    <>
                                        {" "}
                                        · {t.approvedBy} <code className="hash">{r.approver}</code>
                                    </>
                                ) : (
                                    ` · ${t.noApproval}`
                                )}
                            </dd>
                        </dl>
                    )}
                </AsyncView>
            )}
            <form method="dialog">
                <button type="submit" className="btn-secondary">
                    {m.common.close}
                </button>
            </form>
        </dialog>
    );
}
