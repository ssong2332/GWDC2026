"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { AuditResponse } from "@/app/api/_lib/dto";
import { AsyncView } from "../components/AsyncView";
import { useApi } from "../hooks/useApi";
import { useDocumentTitle, useI18n } from "../i18n/LocaleProvider";
import { labelFor } from "../i18n/messages";
import { hashVerdict, normalizeTxInput } from "./auditState";

// ③ Audit (F-13): anyone pastes a tx hash → the vault events of that tx, the local evidence re-hashed against the
// on-chain hash, and the replay verdict. The hash lives in `?tx=` so the result URL can be shared (Architecture 10).
// T-17: event titles come from m.audit.events keyed by the real PolicyVault event names (VaultPaused / VaultUnpaused
// included); the block reason is looked up by code (args.reason) instead of the API's English blockReason label (D-41).

type Item = Extract<AuditResponse["result"], { status: "found" }>["items"][number];
type InputError = "empty" | "invalid" | "urlInvalid";

function AuditItem({ item }: { item: Item }) {
    const { m } = useI18n();
    const t = m.audit;
    const verdict = hashVerdict(item.hashMatch);
    const reasonCode = item.event === "SpendBlocked" && item.args.reason !== undefined ? Number(item.args.reason) : null;
    return (
        <section className="card" aria-label={t.evidenceLabel({ event: item.event })}>
            <div className="row space-between">
                <h2>{labelFor(t.events, item.event) ?? item.event}</h2>
                <div className="row">
                    <span className={`badge badge-${verdict.tone}`}>{t.hashVerdict[verdict.key]}</span>
                    {item.withinPolicy === null ? null : item.withinPolicy ? (
                        <span className="badge badge-ok">{t.withinPolicy}</span>
                    ) : (
                        <span className="badge badge-blocked">{t.outsidePolicy}</span>
                    )}
                </div>
            </div>
            {reasonCode !== null ? (
                <p className="notice notice-warn">
                    <strong>{t.blockedReason}</strong> {labelFor(m.reasons, reasonCode) ?? m.reasons.unknown({ code: reasonCode })}
                </p>
            ) : null}
            {item.approver ? (
                <p>
                    {t.approver} <code className="hash">{item.approver}</code>
                </p>
            ) : null}
            <dl className="receipt">
                <dt>{t.onchainHash}</dt>
                <dd>
                    <code className="hash">{item.onchainHash}</code>
                </dd>
                <dt>{t.recomputed}</dt>
                <dd>{item.recomputedHash ? <code className="hash">{item.recomputedHash}</code> : <span className="muted">{t.noLocal}</span>}</dd>
                <dt>{t.evidenceKind}</dt>
                <dd>{item.evidenceKind ?? "—"}</dd>
            </dl>
            <details>
                <summary>{t.eventArgs}</summary>
                <pre>{JSON.stringify(item.args, null, 2)}</pre>
            </details>
            {item.package !== null ? (
                <details>
                    <summary>{t.evidencePackage}</summary>
                    <pre>{JSON.stringify(item.package, null, 2)}</pre>
                </details>
            ) : null}
        </section>
    );
}

export function AuditView() {
    const { m } = useI18n();
    const t = m.audit;
    useDocumentTitle(t.title);
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const current = params.get("tx") ?? "";
    const [text, setText] = useState(current);
    const [inputError, setInputError] = useState<InputError | null>(null);
    const parsed = normalizeTxInput(current);
    const state = useApi<AuditResponse>(parsed.ok ? `/api/audit/${parsed.tx}` : null);

    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        const r = normalizeTxInput(text);
        if (!r.ok) {
            setInputError(r.reason);
            return;
        }
        setInputError(null);
        router.replace(`${pathname}?tx=${r.tx}`);
    };

    const urlInvalid = current !== "" && !parsed.ok;
    const errorKey: InputError | null = inputError ?? (urlInvalid ? "urlInvalid" : null);
    const error = errorKey ? t.inputErrors[errorKey] : null;

    return (
        <div className="stack">
            <h1>{t.title}</h1>
            <p className="lead">{t.lead}</p>
            <form className="card" onSubmit={onSubmit} noValidate>
                <div className={`field${error ? " field-invalid" : ""}`}>
                    <label htmlFor="tx">{t.txLabel}</label>
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
                        {t.hint}
                    </span>
                    {error ? (
                        <span className="field-error" id="tx-error" role="alert">
                            {error}
                        </span>
                    ) : null}
                </div>
                <div className="row">
                    <button type="submit">{t.submit}</button>
                </div>
            </form>

            {!parsed.ok ? (
                parsed.reason === "empty" ? <p className="muted">{t.noHash}</p> : null
            ) : (
                <AsyncView state={state} loadingLabel={t.loading}>
                    {({ result }) =>
                        result.status === "not_found" ? (
                            <p className="notice notice-warn" role="status">
                                <strong>{t.notFoundStrong}</strong>
                                {t.notFoundRest}
                            </p>
                        ) : (
                            <>
                                <p className="muted">{t.summary({ block: String(result.blockNumber), count: result.items.length })}</p>
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
