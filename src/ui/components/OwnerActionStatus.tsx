"use client";

import type { OwnerActionState } from "../wallet/ownerAction";
import { ErrorNotice, Loading } from "./AsyncView";
import { TxHashLink } from "./TxHashLink";

// Progress of one owner signature (preparing → simulating → awaiting_signature → confirming → done | error).

const STEP_TEXT: Record<"preparing" | "simulating" | "awaiting_signature" | "confirming", string> = {
    preparing: "Preparing the evidence package…",
    simulating: "Checking the transaction against PolicyVault…",
    awaiting_signature: "Confirm the transaction in your wallet…",
    confirming: "Waiting for the transaction to be mined…",
};

export function OwnerActionStatus({ label, state, explorerTxUrl }: { label: string | null; state: OwnerActionState; explorerTxUrl: string | null }) {
    if (state.step === "idle") return null;
    return (
        <section className="action-status" aria-label="Signature status">
            {label ? <h3>{label}</h3> : null}
            {state.step === "done" ? (
                <p className="notice notice-ok" role="status">
                    Done — tx <TxHashLink hash={state.txHash} explorerTxUrl={explorerTxUrl} full />
                </p>
            ) : state.step === "error" ? (
                <>
                    <ErrorNotice error={state.error} />
                    {state.txHash ? (
                        <p>
                            Transaction: <TxHashLink hash={state.txHash} explorerTxUrl={explorerTxUrl} full />
                        </p>
                    ) : null}
                </>
            ) : (
                <>
                    <Loading label={STEP_TEXT[state.step]} />
                    {state.step === "confirming" ? (
                        <p>
                            Transaction: <TxHashLink hash={state.txHash} explorerTxUrl={explorerTxUrl} full />
                        </p>
                    ) : null}
                </>
            )}
        </section>
    );
}
