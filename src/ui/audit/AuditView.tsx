"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { AuditResponse } from "@/app/api/_lib/dto";
import { AsyncView } from "../components/AsyncView";
import { useApi } from "../hooks/useApi";
import { hashVerdict, normalizeTxInput } from "./auditState";

// ③ Audit (F-13): anyone pastes a tx hash → the vault events of that tx, the local evidence re-hashed against the
// on-chain hash, and the replay verdict. The hash lives in `?tx=` so the result URL can be shared (Architecture 10).

type Item = Extract<AuditResponse["result"], { status: "found" }>["items"][number];

const EVENT_LABELS: Record<string, string> = {
    SpendExecuted: "Payment executed",
    SpendBlocked: "Payment blocked",
    SpendPending: "Payment held for approval",
    Approved: "Approved by owner",
    Rejected: "Rejected by owner",
    PolicySet: "Policy registered",
    Paused: "Vault paused",
    Unpaused: "Vault resumed",
};

function policyVerdict(withinPolicy: boolean | null) {
    if (withinPolicy === null) return null;
    return withinPolicy ? <span className="badge badge-ok">Within policy (replayed)</span> : <span className="badge badge-blocked">Outside policy (replayed)</span>;
}

function AuditItem({ item }: { item: Item }) {
    const verdict = hashVerdict(item.hashMatch);
    return (
        <section className="card" aria-label={`${item.event} evidence`}>
            <div className="row space-between">
                <h2>{EVENT_LABELS[item.event] ?? item.event}</h2>
                <div className="row">
                    <span className={`badge badge-${verdict.tone}`}>{verdict.label}</span>
                    {policyVerdict(item.withinPolicy)}
                </div>
            </div>
            {item.blockReason ? (
                <p className="notice notice-warn">
                    <strong>Blocked reason:</strong> {item.blockReason}
                </p>
            ) : null}
            {item.approver ? (
                <p>
                    Approver: <code className="hash">{item.approver}</code>
                </p>
            ) : null}
            <dl className="receipt">
                <dt>On-chain evidence hash</dt>
                <dd>
                    <code className="hash">{item.onchainHash}</code>
                </dd>
                <dt>Recomputed from the stored package</dt>
                <dd>{item.recomputedHash ? <code className="hash">{item.recomputedHash}</code> : <span className="muted">— (no local evidence for this hash)</span>}</dd>
                <dt>Evidence kind</dt>
                <dd>{item.evidenceKind ?? "—"}</dd>
            </dl>
            <details>
                <summary>Event arguments</summary>
                <pre>{JSON.stringify(item.args, null, 2)}</pre>
            </details>
            {item.package !== null ? (
                <details>
                    <summary>Evidence package (policy, request, AI judgment, tokens)</summary>
                    <pre>{JSON.stringify(item.package, null, 2)}</pre>
                </details>
            ) : null}
        </section>
    );
}

export function AuditView() {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const current = params.get("tx") ?? "";
    const [text, setText] = useState(current);
    const [inputError, setInputError] = useState<string | null>(null);
    const parsed = normalizeTxInput(current);
    const state = useApi<AuditResponse>(parsed.ok ? `/api/audit/${parsed.tx}` : null);

    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        const r = normalizeTxInput(text);
        if (!r.ok) {
            setInputError(r.reason === "empty" ? "Enter a transaction hash." : "A transaction hash is 0x followed by 64 hex characters.");
            return;
        }
        setInputError(null);
        router.replace(`${pathname}?tx=${r.tx}`);
    };

    const urlInvalid = current !== "" && !parsed.ok;
    const error = inputError ?? (urlInvalid ? "The tx in the URL is not a valid transaction hash (0x + 64 hex characters)." : null);

    return (
        <div className="stack">
            <h1>Audit</h1>
            <p className="lead">
                Paste a transaction hash. The on-chain event is matched with its stored evidence, the evidence is re-hashed, and payments are replayed
                against the policy — anyone can check whether a payment stayed inside the delegation.
            </p>
            <form className="card" onSubmit={onSubmit} noValidate>
                <div className={`field${error ? " field-invalid" : ""}`}>
                    <label htmlFor="tx">Transaction hash</label>
                    <input
                        id="tx"
                        name="tx"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="0x…"
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? "tx-error" : "tx-hint"}
                    />
                    <span className="hint" id="tx-hint">
                        0x + 64 hex characters. The result URL can be shared.
                    </span>
                    {error ? (
                        <span className="field-error" id="tx-error" role="alert">
                            {error}
                        </span>
                    ) : null}
                </div>
                <div className="row">
                    <button type="submit">Reconstruct evidence</button>
                </div>
            </form>

            {!parsed.ok ? (
                parsed.reason === "empty" ? <p className="muted">No transaction hash yet — enter one above to reconstruct its evidence.</p> : null
            ) : (
                <AsyncView state={state} loadingLabel="Reading the transaction and its evidence…">
                    {({ result }) =>
                        result.status === "not_found" ? (
                            <p className="notice notice-warn" role="status">
                                <strong>No record found</strong> — this transaction has no PolicyVault event on this network.
                            </p>
                        ) : (
                            <>
                                <p className="muted">
                                    Block {result.blockNumber} · {result.items.length} vault event{result.items.length === 1 ? "" : "s"}
                                </p>
                                {result.items.map((item, i) => (
                                    <AuditItem key={`${item.event}-${i}`} item={item} />
                                ))}
                            </>
                        )
                    }
                </AsyncView>
            )}
        </div>
    );
}
