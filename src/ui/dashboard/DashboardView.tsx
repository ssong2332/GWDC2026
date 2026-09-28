"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { ActivityResponse, VaultStateResponse } from "@/app/api/_lib/dto";
import { DASHBOARD_POLL_MS } from "@/config/constants";
import type { Hex } from "@/core/domain/types";
import { AsyncView } from "../components/AsyncView";
import { OwnerActionStatus } from "../components/OwnerActionStatus";
import { useApi } from "../hooks/useApi";
import { chainLabel } from "../wallet/chains";
import { useOwnerAction } from "../wallet/useOwnerAction";
import { WalletGate } from "../wallet/WalletGate";
import { useWallet } from "../wallet/WalletProvider";
import { newestFirst, openPendings } from "./activity";
import { ActivityList, BudgetSummary, PendingRow, ReceiptDialog } from "./DashboardParts";

// Screen ② Dashboard (PRD 화면 ②; F-04 ②, F-05 ①, F-10): budget, approval inbox, pause, activity, receipts.
// Polls every 5 s and re-reads right after a signature completes.

export function DashboardView() {
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
                <h1>Dashboard</h1>
                {v ? (
                    <span className="muted small">
                        {chainLabel(v.chainId)} · vault <code className="hash">{v.vault}</code>
                    </span>
                ) : null}
            </div>

            <AsyncView state={vault} loadingLabel="Reading the vault state from the chain…">
                {(data) =>
                    data.state.policyVersion === "0" ? (
                        <section className="card" aria-label="No policy">
                            <h2>No policy registered</h2>
                            <p>The agent cannot spend anything until you delegate a budget.</p>
                            <p>
                                <Link href="/delegate">Delegate first →</Link>
                            </p>
                        </section>
                    ) : (
                        <BudgetSummary v={data} />
                    )
                }
            </AsyncView>

            {v ? (
                <section className="card" aria-label="Owner controls">
                    <h2>Owner controls</h2>
                    <WalletGate target={target}>
                        <div className="row">
                            <button
                                type="button"
                                className="btn-danger"
                                disabled={action.busy || v.state.paused}
                                onClick={() => owner && void action.run("Pause all spending", { kind: "pause", owner, note: "Paused from the dashboard" })}
                            >
                                Pause all spending
                            </button>
                            {v.state.paused ? <span className="muted">The vault is paused. Resuming is not available in the UI.</span> : null}
                        </div>
                    </WalletGate>
                    <OwnerActionStatus label={action.label} state={action.state} explorerTxUrl={explorer} />
                </section>
            ) : null}

            <section className="card" aria-label="Approval inbox">
                <h2>Approval inbox</h2>
                <AsyncView
                    state={activity}
                    loadingLabel="Reading vault events…"
                    isEmpty={(d) => openPendings(d.items).length === 0}
                    empty={<p className="muted">No pending requests.</p>}
                >
                    {(d) => (
                        <WalletGate target={target}>
                            <ul className="pending-list">
                                {openPendings(d.items).map((item) => (
                                    <PendingRow
                                        key={item.requestId}
                                        item={item}
                                        disabled={action.busy}
                                        onApprove={() => owner && item.requestId && void action.run("Approve request", { kind: "approval", owner, requestId: item.requestId })}
                                        onReject={() => owner && item.requestId && void action.run("Reject request", { kind: "rejection", owner, requestId: item.requestId })}
                                    />
                                ))}
                            </ul>
                        </WalletGate>
                    )}
                </AsyncView>
            </section>

            <section className="card" aria-label="Activity">
                <h2>Activity</h2>
                <AsyncView state={activity} loadingLabel="Reading vault events…" isEmpty={(d) => d.items.length === 0} empty={<p className="muted">No spending activity yet.</p>}>
                    {(d) => <ActivityList items={newestFirst(d.items)} explorerTxUrl={explorer} onReceipt={setReceiptFor} />}
                </AsyncView>
            </section>

            <ReceiptDialog requestId={receiptFor} explorerTxUrl={explorer} onClose={() => setReceiptFor(null)} />
        </div>
    );
}
