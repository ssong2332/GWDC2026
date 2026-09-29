"use client";

import { useI18n } from "../i18n/LocaleProvider";
import type { Messages } from "../i18n/messages";
import type { OwnerActionState } from "../wallet/ownerAction";
import { ErrorNotice, Loading } from "./AsyncView";
import { TxHashLink } from "./TxHashLink";

// Progress of one owner signature (preparing → simulating → awaiting_signature → confirming → done | error).
// The action name is a dictionary key so it follows a language switch (T-17).

export type OwnerActionLabel = keyof Messages["ownerAction"]["labels"];

export function OwnerActionStatus({ label, state, explorerTxUrl }: { label: OwnerActionLabel | null; state: OwnerActionState; explorerTxUrl: string | null }) {
    const { m } = useI18n();
    if (state.step === "idle") return null;
    const t = m.ownerAction;
    return (
        <section className="action-status" aria-label={t.statusLabel}>
            {label ? <h3>{t.labels[label]}</h3> : null}
            {state.step === "done" ? (
                <p className="notice notice-ok" role="status">
                    {t.done} <TxHashLink hash={state.txHash} explorerTxUrl={explorerTxUrl} full />
                </p>
            ) : state.step === "error" ? (
                <>
                    <ErrorNotice error={state.error} />
                    {state.txHash ? (
                        <p>
                            {t.transaction} <TxHashLink hash={state.txHash} explorerTxUrl={explorerTxUrl} full />
                        </p>
                    ) : null}
                </>
            ) : (
                <>
                    <Loading label={t.steps[state.step]} />
                    {state.step === "confirming" ? (
                        <p>
                            {t.transaction} <TxHashLink hash={state.txHash} explorerTxUrl={explorerTxUrl} full />
                        </p>
                    ) : null}
                </>
            )}
        </section>
    );
}
