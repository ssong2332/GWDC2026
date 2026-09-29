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
import { useOwnerAction } from "../wallet/useOwnerAction";
import { WalletGate } from "../wallet/WalletGate";
import { useWallet } from "../wallet/WalletProvider";
import { buildPolicySetBody, delegateReducer, delegationFieldError, initialDelegateState, type FormErrors, type PolicyForm } from "./delegateState";

// Screen ① Delegate (PRD 화면 ①, F-01, F-02): sentence → Kiln candidate → owner review/edit (expiry) → wallet signature.

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
        void action.run("Register policy", built.body);
    }

    const f = s.form;
    const textError = delegationFieldError(s.phase === "parse_error" ? s.error : null);
    const pendingCount = vault.data?.state.pendingCount ?? 0;
    const currentVersion = vault.data ? Number(vault.data.state.policyVersion) : 0;

    return (
        <div className="stack">
            <h1>Delegate</h1>
            <p className="lead">Write one sentence that hands the event budget to the agent. The policy it becomes is checked by code, shown to you, and only takes effect when you sign it with your wallet.</p>

            <form className="card" onSubmit={onParse}>
                <Field id="delegation" label="Delegation sentence" hint={`${s.text.length}/${INPUT_LIMITS.delegationTextMax} characters`} error={textError ?? undefined}>
                    <textarea
                        id="delegation"
                        rows={3}
                        maxLength={INPUT_LIMITS.delegationTextMax}
                        value={s.text}
                        placeholder={`e.g. ${EXAMPLE}`}
                        aria-invalid={textError ? true : undefined}
                        aria-describedby={textError ? "delegation-error" : "delegation-hint"}
                        onChange={(e) => dispatch({ type: "text_changed", text: e.target.value })}
                        disabled={s.phase === "parsing" || action.busy}
                    />
                </Field>
                <div className="row">
                    <button type="submit" disabled={s.text.trim() === "" || s.phase === "parsing" || action.busy}>
                        Convert to policy
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => dispatch({ type: "text_changed", text: EXAMPLE })} disabled={s.phase === "parsing" || action.busy}>
                        Use example sentence
                    </button>
                </div>
                {s.text.trim() === "" ? <p className="muted">Enter a sentence to see the policy. Mention the total budget, the allowed merchants and when to ask you.</p> : null}
            </form>

            {s.phase === "parsing" ? <Loading label="Converting with Kiln…" /> : null}

            {s.phase === "parse_error" && s.error ? (
                <section className="card" aria-label="Conversion failed">
                    <h2>Policy not applied</h2>
                    <ErrorNotice error={s.error} />
                </section>
            ) : null}

            {(s.phase === "parsed" || s.phase === "registered") && f && s.candidate ? (
                <section className="card" aria-label="Policy review">
                    <h2>Review the policy</h2>
                    {usage?.provider === "fake" ? <p className="notice notice-warn">Simulated Kiln (fake) — no real model call was made.</p> : null}
                    {s.warnings.length > 0 ? (
                        <ul className="notice notice-warn">
                            {s.warnings.map((w) => (
                                <li key={w}>{w}</li>
                            ))}
                        </ul>
                    ) : null}
                    <fieldset className="plain-fieldset" disabled={s.phase === "registered" || action.busy}>
                        <div className="grid-2">
                            <Field id="budget" label="Total budget (KRW)" error={errors.budget}>
                                <input id="budget" inputMode="numeric" value={f.budget} onChange={(e) => setForm({ budget: e.target.value })} aria-invalid={!!errors.budget} />
                            </Field>
                            <Field id="threshold" label="Ask me above (KRW per payment)" error={errors.approvalThreshold}>
                                <input
                                    id="threshold"
                                    inputMode="numeric"
                                    value={f.approvalThreshold}
                                    onChange={(e) => setForm({ approvalThreshold: e.target.value })}
                                    aria-invalid={!!errors.approvalThreshold}
                                />
                            </Field>
                            <Field
                                id="expiry"
                                label="Expires on (23:59:59 KST)"
                                error={errors.expiresOn}
                                hint={s.candidate.expiresOn ? "Filled from the sentence — you can change it." : "The sentence has no expiry — enter a date."}
                            >
                                <input
                                    id="expiry"
                                    type="date"
                                    value={f.expiresOn}
                                    onChange={(e) => setForm({ expiresOn: e.target.value })}
                                    aria-invalid={!!errors.expiresOn}
                                    aria-describedby="expiry-hint"
                                />
                            </Field>
                            <Field id="purpose" label="Purpose" error={errors.purpose}>
                                <input id="purpose" value={f.purpose} maxLength={POLICY_RULES.purposeMax} onChange={(e) => setForm({ purpose: e.target.value })} aria-invalid={!!errors.purpose} />
                            </Field>
                            <Field id="per-minute" label="Max payments per minute" error={errors.maxPerMinute}>
                                <input id="per-minute" inputMode="numeric" value={f.maxPerMinute} onChange={(e) => setForm({ maxPerMinute: e.target.value })} aria-invalid={!!errors.maxPerMinute} />
                            </Field>
                            <Field id="per-day" label="Max payments per day" error={errors.maxPerDay}>
                                <input id="per-day" inputMode="numeric" value={f.maxPerDay} onChange={(e) => setForm({ maxPerDay: e.target.value })} aria-invalid={!!errors.maxPerDay} />
                            </Field>
                        </div>
                        <fieldset className="merchants">
                            <legend>Allowed merchants</legend>
                            {MERCHANT_REGISTRY.map((m) => (
                                <label key={m.id} className="check">
                                    <input
                                        type="checkbox"
                                        checked={f.merchantIds.includes(m.id)}
                                        onChange={(e) =>
                                            setForm({ merchantIds: e.target.checked ? [...f.merchantIds, m.id] : f.merchantIds.filter((id) => id !== m.id) })
                                        }
                                    />
                                    {m.displayName}
                                </label>
                            ))}
                            {errors.merchantIds ? (
                                <span className="field-error" role="alert">
                                    {errors.merchantIds}
                                </span>
                            ) : null}
                        </fieldset>
                    </fieldset>
                    {usage ? (
                        <p className="muted small">
                            Kiln call: {usage.promptTokens} prompt / {usage.completionTokens} completion / {usage.reasoningTokens ?? "n/a"} reasoning tokens
                            {usage.costUsd ? ` · $${usage.costUsd}` : ""}
                            {usage.generationId ? ` · Generation-Id ${usage.generationId}` : ""}
                        </p>
                    ) : null}
                </section>
            ) : null}

            {s.phase === "parsed" && f ? (
                <section className="card" aria-label="Sign">
                    <h2>Sign and register</h2>
                    {vault.status === "error" && vault.error ? <ErrorNotice error={vault.error} onRetry={vault.reload} /> : null}
                    {currentVersion > 0 ? <p className="muted">This replaces the current policy (version {currentVersion}) and resets the spent amount.</p> : null}
                    {pendingCount > 0 ? (
                        <p className="notice notice-warn">
                            {pendingCount} pending request(s) must be approved or rejected on the <Link href="/dashboard">dashboard</Link> before a new policy can be registered.
                        </p>
                    ) : null}
                    <WalletGate target={target}>
                        <button type="button" onClick={onSign} disabled={action.busy}>
                            Sign and register policy
                        </button>
                    </WalletGate>
                    <OwnerActionStatus label={action.label} state={action.state} explorerTxUrl={explorer} />
                </section>
            ) : null}

            {s.phase === "registered" && s.txHash ? (
                <section className="card" aria-label="Registered">
                    <h2>Policy registered</h2>
                    <p className="notice notice-ok" role="status">
                        PolicyVault now enforces this policy. Transaction: <TxHashLink hash={s.txHash} explorerTxUrl={explorer} full />
                    </p>
                    <p>
                        <Link href="/dashboard">Go to the dashboard</Link>
                    </p>
                </section>
            ) : null}
        </div>
    );
}
