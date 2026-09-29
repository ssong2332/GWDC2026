"use client";

import Link from "next/link";
import { useCallback, useReducer, useState } from "react";
import type { ParsePolicyResponse, VaultStateResponse } from "@/app/api/_lib/dto";
import { INPUT_LIMITS, POLICY_RULES } from "@/config/constants";
import type { Hex } from "@/core/domain/types";
import { MERCHANT_REGISTRY } from "@/config/merchants";
import { postJson } from "../apiClient";
import { ErrorNotice, Loading } from "../components/AsyncView";
import { OwnerActionStatus } from "../components/OwnerActionStatus";
import { TxHashLink } from "../components/TxHashLink";
import { useApi } from "../hooks/useApi";
import { useDocumentTitle, useI18n } from "../i18n/LocaleProvider";
import { useOwnerAction } from "../wallet/useOwnerAction";
import { WalletGate } from "../wallet/WalletGate";
import { useWallet } from "../wallet/WalletProvider";
import { FIELD_ERROR_LIMITS, buildPolicySetBody, delegateReducer, delegationFieldError, initialDelegateState, type FormErrors, type PolicyForm } from "./delegateState";

// Screen ① Delegate (PRD 화면 ①, F-01, F-02): sentence → Kiln candidate → owner review/edit (expiry) → wallet signature.
// T-17: fixed text from the selected dictionary; the Kiln purpose, the sentence and merchant names are shown as they are (F-17 ⑦⑨).

const EXAMPLE = "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐";

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className={`field${error ? " field-invalid" : ""}`}>
            <label htmlFor={id}>{label}</label>
            {children}
            {hint ? (
                <span className="hint" id={`${id}-hint`}>
                    {hint}
                </span>
            ) : null}
            {error ? (
                <span className="field-error" id={`${id}-error`} role="alert">
                    {error}
                </span>
            ) : null}
        </div>
    );
}

export function DelegateView() {
    const { m } = useI18n();
    const t = m.delegate;
    useDocumentTitle(t.title);
    const vault = useApi<VaultStateResponse>("/api/vault/state");
    const { wallet } = useWallet();
    const [s, dispatch] = useReducer(delegateReducer, initialDelegateState);
    const [usage, setUsage] = useState<ParsePolicyResponse["usage"]>(null);
    const [errors, setErrors] = useState<FormErrors>({});
    const action = useOwnerAction(useCallback((done: { txHash: Hex }) => dispatch({ type: "registered", txHash: done.txHash }), []));
    const explorer = vault.data?.explorerTxUrl ?? null;
    const target = vault.data ? { owner: vault.data.owner, chainId: vault.data.chainId } : null;

    async function onParse(e: React.FormEvent) {
        e.preventDefault();
        if (s.text.trim() === "" || s.phase === "parsing") return;
        dispatch({ type: "parse_started" });
        setErrors({});
        action.reset();
        const r = await postJson<ParsePolicyResponse>("/api/policy/parse", { delegationText: s.text });
        if (r.ok) {
            setUsage(r.data.usage);
            dispatch({ type: "parse_succeeded", parseCallId: r.data.parseCallId, candidate: r.data.candidate, warnings: r.data.warnings });
        } else {
            setUsage(null);
            dispatch({ type: "parse_failed", error: r.error });
        }
    }

    function setForm(patch: Partial<PolicyForm>) {
        dispatch({ type: "form_changed", patch });
    }

    function onSign() {
        if (!s.form || !s.candidate || wallet.address === null) return;
        const built = buildPolicySetBody({
            form: s.form,
            candidate: s.candidate,
            parseCallId: s.parseCallId,
            delegationText: s.text,
            owner: wallet.address,
            nowSec: Math.floor(Date.now() / 1000),
        });
        if (!built.ok) {
            setErrors(built.errors);
            return;
        }
        setErrors({});
        void action.run("register", built.body);
    }

    const f = s.form;
    const textErrorKey = delegationFieldError(s.phase === "parse_error" ? s.error : null);
    const textError = textErrorKey ? t.fieldErrors[textErrorKey](FIELD_ERROR_LIMITS) : null;
    const fieldError = (k: keyof PolicyForm): string | undefined => {
        const key = errors[k];
        return key ? t.fieldErrors[key](FIELD_ERROR_LIMITS) : undefined;
    };
    const pendingCount = vault.data?.state.pendingCount ?? 0;
    const currentVersion = vault.data ? Number(vault.data.state.policyVersion) : 0;

    return (
        <div className="stack">
            <h1>{t.title}</h1>
            <p className="lead">{t.lead}</p>

            <form className="card" onSubmit={onParse}>
                <Field id="delegation" label={t.sentenceLabel} hint={t.charCount({ count: s.text.length, max: INPUT_LIMITS.delegationTextMax })} error={textError ?? undefined}>
                    <textarea
                        id="delegation"
                        rows={3}
                        maxLength={INPUT_LIMITS.delegationTextMax}
                        value={s.text}
                        placeholder={t.placeholder({ example: EXAMPLE })}
                        aria-invalid={textError ? true : undefined}
                        aria-describedby={textError ? "delegation-error" : "delegation-hint"}
                        onChange={(e) => dispatch({ type: "text_changed", text: e.target.value })}
                        disabled={s.phase === "parsing" || action.busy}
                    />
                </Field>
                <div className="row">
                    <button type="submit" disabled={s.text.trim() === "" || s.phase === "parsing" || action.busy}>
                        {t.convert}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => dispatch({ type: "text_changed", text: EXAMPLE })} disabled={s.phase === "parsing" || action.busy}>
                        {t.useExample}
                    </button>
                </div>
                {s.text.trim() === "" ? <p className="muted">{t.emptyHint}</p> : null}
            </form>

            {s.phase === "parsing" ? <Loading label={t.converting} /> : null}

            {s.phase === "parse_error" && s.error ? (
                <section className="card" aria-label={t.failedLabel}>
                    <h2>{t.notApplied}</h2>
                    <ErrorNotice error={s.error} />
                </section>
            ) : null}

            {(s.phase === "parsed" || s.phase === "registered") && f && s.candidate ? (
                <section className="card" aria-label={t.reviewLabel}>
                    <h2>{t.reviewTitle}</h2>
                    {usage?.provider === "fake" ? <p className="notice notice-warn">{t.fakeKiln}</p> : null}
                    {/* The API's English `warnings` stay in the response; the screen builds them from the candidate (D-41). */}
                    {s.candidate.unrecognizedMerchants.length > 0 ? (
                        <ul className="notice notice-warn">
                            {s.candidate.unrecognizedMerchants.map((name) => (
                                <li key={name}>{t.unrecognizedMerchant({ name })}</li>
                            ))}
                        </ul>
                    ) : null}
                    <fieldset className="plain-fieldset" disabled={s.phase === "registered" || action.busy}>
                        <div className="grid-2">
                            <Field id="budget" label={t.fields.budget} error={fieldError("budget")}>
                                <input id="budget" inputMode="numeric" value={f.budget} onChange={(e) => setForm({ budget: e.target.value })} aria-invalid={!!errors.budget} />
                            </Field>
                            <Field id="threshold" label={t.fields.threshold} error={fieldError("approvalThreshold")}>
                                <input
                                    id="threshold"
                                    inputMode="numeric"
                                    value={f.approvalThreshold}
                                    onChange={(e) => setForm({ approvalThreshold: e.target.value })}
                                    aria-invalid={!!errors.approvalThreshold}
                                />
                            </Field>
                            <Field id="expiry" label={t.fields.expiry} error={fieldError("expiresOn")} hint={s.candidate.expiresOn ? t.expiryFromSentence : t.expiryMissing}>
                                <input
                                    id="expiry"
                                    type="date"
                                    value={f.expiresOn}
                                    onChange={(e) => setForm({ expiresOn: e.target.value })}
                                    aria-invalid={!!errors.expiresOn}
                                    aria-describedby="expiry-hint"
                                />
                            </Field>
                            <Field id="purpose" label={t.fields.purpose} error={fieldError("purpose")}>
                                <input id="purpose" value={f.purpose} maxLength={POLICY_RULES.purposeMax} onChange={(e) => setForm({ purpose: e.target.value })} aria-invalid={!!errors.purpose} />
                            </Field>
                            <Field id="per-minute" label={t.fields.perMinute} error={fieldError("maxPerMinute")}>
                                <input id="per-minute" inputMode="numeric" value={f.maxPerMinute} onChange={(e) => setForm({ maxPerMinute: e.target.value })} aria-invalid={!!errors.maxPerMinute} />
                            </Field>
                            <Field id="per-day" label={t.fields.perDay} error={fieldError("maxPerDay")}>
                                <input id="per-day" inputMode="numeric" value={f.maxPerDay} onChange={(e) => setForm({ maxPerDay: e.target.value })} aria-invalid={!!errors.maxPerDay} />
                            </Field>
                        </div>
                        <fieldset className="merchants">
                            <legend>{t.fields.merchants}</legend>
                            {MERCHANT_REGISTRY.map((mr) => (
                                <label key={mr.id} className="check">
                                    <input
                                        type="checkbox"
                                        checked={f.merchantIds.includes(mr.id)}
                                        onChange={(e) =>
                                            setForm({ merchantIds: e.target.checked ? [...f.merchantIds, mr.id] : f.merchantIds.filter((id) => id !== mr.id) })
                                        }
                                    />
                                    {mr.displayName}
                                </label>
                            ))}
                            {errors.merchantIds ? (
                                <span className="field-error" role="alert">
                                    {fieldError("merchantIds")}
                                </span>
                            ) : null}
                        </fieldset>
                    </fieldset>
                    {usage ? (
                        <p className="muted small">
                            {t.usage({
                                prompt: usage.promptTokens,
                                completion: usage.completionTokens,
                                reasoning: usage.reasoningTokens === null ? m.common.notAvailable : String(usage.reasoningTokens),
                            })}
                            {usage.costUsd ? ` · $${usage.costUsd}` : ""}
                            {usage.generationId ? ` · ${m.common.generationId} ${usage.generationId}` : ""}
                        </p>
                    ) : null}
                </section>
            ) : null}

            {s.phase === "parsed" && f ? (
                <section className="card" aria-label={t.signLabel}>
                    <h2>{t.signTitle}</h2>
                    {vault.status === "error" && vault.error ? <ErrorNotice error={vault.error} onRetry={vault.reload} /> : null}
                    {currentVersion > 0 ? <p className="muted">{t.replaces({ version: currentVersion })}</p> : null}
                    {pendingCount > 0 ? (
                        <p className="notice notice-warn">
                            {t.pendingBefore({ count: pendingCount })}
                            <Link href="/dashboard">{t.pendingLink}</Link>
                            {t.pendingAfter({ count: pendingCount })}
                        </p>
                    ) : null}
                    <WalletGate target={target}>
                        <button type="button" onClick={onSign} disabled={action.busy}>
                            {t.signButton}
                        </button>
                    </WalletGate>
                    <OwnerActionStatus label={action.label} state={action.state} explorerTxUrl={explorer} />
                </section>
            ) : null}

            {s.phase === "registered" && s.txHash ? (
                <section className="card" aria-label={t.registeredLabel}>
                    <h2>{t.registeredTitle}</h2>
                    <p className="notice notice-ok" role="status">
                        {t.registeredNotice} <TxHashLink hash={s.txHash} explorerTxUrl={explorer} full />
                    </p>
                    <p>
                        <Link href="/dashboard">{t.goDashboard}</Link>
                    </p>
                </section>
            ) : null}
        </div>
    );
}
