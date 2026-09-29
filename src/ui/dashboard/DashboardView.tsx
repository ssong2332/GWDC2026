"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { ActivityResponse, VaultStateResponse } from "@/app/api/_lib/dto";
import { DASHBOARD_POLL_MS } from "@/config/constants";
import type { Hex } from "@/core/domain/types";
import { AsyncView } from "../components/AsyncView";
import { OwnerActionStatus } from "../components/OwnerActionStatus";
import { useApi } from "../hooks/useApi";
import { useDocumentTitle, useI18n } from "../i18n/LocaleProvider";
import { chainLabel } from "../wallet/chains";
import { useOwnerAction } from "../wallet/useOwnerAction";
import { WalletGate } from "../wallet/WalletGate";
import { useWallet } from "../wallet/WalletProvider";
import { newestFirst, openPendings } from "./activity";
import { ActivityList, BudgetSummary, PendingRow, ReceiptDialog } from "./DashboardParts";

// Screen ② Dashboard (PRD 화면 ②; F-04 ②, F-05 ①, F-10): budget, approval inbox, pause, activity, receipts.
// Polls every 5 s and re-reads right after a signature completes. T-17: fixed text from the selected dictionary.

export function DashboardView() {
    const { m } = useI18n();
    const t = m.dashboard;
    useDocumentTitle(t.title);
    const vault = useApi<VaultStateResponse>("/api/vault/state", { pollMs: DASHBOARD_POLL_MS });
    const activity = useApi<ActivityResponse>("/api/vault/activity", { pollMs: DASHBOARD_POLL_MS });
    const { wallet } = useWallet();
    const [receiptFor, setReceiptFor] = useState<Hex | null>(null);
    const { reload: reloadVault } = vault;
    const { reload: reloadActivity } = activity;
    const action = useOwnerAction(
        useCallback(() => {
            reloadVault();
            reloadActivity();
        }, [reloadVault, reloadActivity]),
    );

    const v = vault.data;
    const explorer = v?.explorerTxUrl ?? null;
    const target = v ? { owner: v.owner, chainId: v.chainId } : null;
    const owner = wallet.address;

    return (
        <div className="stack">
            <div className="row space-between">
                <h1>{t.title}</h1>
                {v ? (
                    <span className="muted small">
                        {chainLabel(v.chainId)} · {t.vault} <code className="hash">{v.vault}</code>
                    </span>
                ) : null}
            </div>

            <AsyncView state={vault} loadingLabel={t.loadingVault}>
                {(data) =>
                    data.state.policyVersion === "0" ? (
                        <section className="card" aria-label={t.noPolicyLabel}>
                            <h2>{t.noPolicyTitle}</h2>
                            <p>{t.noPolicyBody}</p>
                            <p>
                                <Link href="/delegate">{t.delegateFirst}</Link>
                            </p>
                        </section>
                    ) : (
                        <BudgetSummary v={data} />
                    )
                }
            </AsyncView>

            {v ? (
                <section className="card" aria-label={t.ownerControls}>
                    <h2>{t.ownerControls}</h2>
                    <WalletGate target={target}>
                        <div className="row">
                            <button
                                type="button"
                                className="btn-danger"
                                disabled={action.busy || v.state.paused}
                                /* The note goes into the evidence (request body) — fixed English, never the UI language (F-17 ④). */
                                onClick={() => owner && void action.run("pause", { kind: "pause", owner, note: "Paused from the dashboard" })}
                            >
                                {t.pauseButton}
                            </button>
                            {v.state.paused ? <span className="muted">{t.pausedNote}</span> : null}
                        </div>
                    </WalletGate>
                    <OwnerActionStatus label={action.label} state={action.state} explorerTxUrl={explorer} />
                </section>
            ) : null}

            <section className="card" aria-label={t.inbox}>
                <h2>{t.inbox}</h2>
                <AsyncView
                    state={activity}
                    loadingLabel={t.loadingEvents}
                    isEmpty={(d) => openPendings(d.items).length === 0}
                    empty={<p className="muted">{t.noPending}</p>}
                >
                    {(d) => (
                        <WalletGate target={target}>
                            <ul className="pending-list">
                                {openPendings(d.items).map((item) => (
                                    <PendingRow
                                        key={item.requestId}
                                        item={item}
                                        disabled={action.busy}
                                        onApprove={() => owner && item.requestId && void action.run("approve", { kind: "approval", owner, requestId: item.requestId })}
                                        onReject={() => owner && item.requestId && void action.run("reject", { kind: "rejection", owner, requestId: item.requestId })}
                                    />
                                ))}
                            </ul>
                        </WalletGate>
                    )}
                </AsyncView>
            </section>

            <section className="card" aria-label={t.activity}>
                <h2>{t.activity}</h2>
                <AsyncView state={activity} loadingLabel={t.loadingEvents} isEmpty={(d) => d.items.length === 0} empty={<p className="muted">{t.noActivity}</p>}>
                    {(d) => <ActivityList items={newestFirst(d.items)} explorerTxUrl={explorer} onReceipt={setReceiptFor} />}
                </AsyncView>
            </section>

            <ReceiptDialog requestId={receiptFor} explorerTxUrl={explorer} onClose={() => setReceiptFor(null)} />
        </div>
    );
}
