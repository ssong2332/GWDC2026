"use client";

import type { EfficiencyResponse } from "@/app/api/_lib/dto";
import { AsyncView } from "../components/AsyncView";
import { useApi } from "../hooks/useApi";

// ④ Efficiency (F-14): per-flow Kiln usage from SQLite, rule-blocked requests at 0 tokens, and the energy estimate (2-card scenario, D-38)
// with its formula and assumptions (D-20 — an estimate, not a measurement).

type Report = EfficiencyResponse["report"];

const FLOW_LABELS: Record<string, string> = {
    policy_parse: "Policy conversion (Kiln)",
    intent_judge: "Intent judgment (Kiln)",
    rule_block: "Rule pre-check block (no Kiln call)",
};

const wh = (n: number) => n.toFixed(4);
const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));

function UsageTable({ report }: { report: Report }) {
    const t = report.totals;
    return (
        <div className="table-wrap">
            <table>
                <caption className="sr-only">Kiln usage per flow</caption>
                <thead>
                    <tr>
                        <th scope="col">Flow</th>
                        <th scope="col" className="num">Kiln calls</th>
                        <th scope="col" className="num">Requests</th>
                        <th scope="col" className="num">Prompt</th>
                        <th scope="col" className="num">Completion</th>
                        <th scope="col" className="num">Reasoning</th>
                        <th scope="col" className="num">Total tokens</th>
                        <th scope="col" className="num">Cost (USD)</th>
                        <th scope="col" className="num">Energy est., 2-card scenario (Wh)</th>
                        <th scope="col">Generation-Id</th>
                    </tr>
                </thead>
                <tbody>
                    {report.rows.length === 0 ? (
                        <tr>
                            <td colSpan={10} className="muted">
                                No Kiln calls recorded
                            </td>
                        </tr>
                    ) : (
                        report.rows.map((r) => (
                            <tr key={r.flow}>
                                <th scope="row">{FLOW_LABELS[r.flow] ?? r.flow}</th>
                                <td className="num">{n(r.kilnCalls)}</td>
                                <td className="num">{n(r.requests)}</td>
                                <td className="num">{n(r.promptTokens)}</td>
                                <td className="num">{n(r.completionTokens)}</td>
                                <td className="num">{n(r.reasoningTokens)}</td>
                                <td className="num">{n(r.totalTokens)}</td>
                                <td className="num">{r.costUsd}</td>
                                <td className="num">{wh(r.energyWhUpper)}</td>
                                <td>
                                    {r.generationIds.length === 0 ? (
                                        <span className="muted">—</span>
                                    ) : (
                                        <details>
                                            <summary>{r.generationIds.length} id{r.generationIds.length === 1 ? "" : "s"}</summary>
                                            <ul className="small">
                                                {r.generationIds.map((g) => (
                                                    <li key={g}>
                                                        <code className="hash">{g}</code>
                                                    </li>
                                                ))}
                                            </ul>
                                        </details>
                                    )}
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
                <tfoot>
                    <tr>
                        <th scope="row">Total (Kiln flows)</th>
                        <td className="num">{n(t.kilnCalls)}</td>
                        <td className="num">—</td>
                        <td className="num">{n(t.promptTokens)}</td>
                        <td className="num">{n(t.completionTokens)}</td>
                        <td className="num">{n(t.reasoningTokens)}</td>
                        <td className="num">{n(t.totalTokens)}</td>
                        <td className="num">{t.costUsd}</td>
                        <td className="num">{wh(t.energyWhUpper)}</td>
                        <td />
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}

export function EfficiencyView() {
    const state = useApi<EfficiencyResponse>("/api/efficiency");
    return (
        <div className="stack">
            <h1>Efficiency</h1>
            <p className="lead">
                Tokens, cost and calls per flow. Requests the rule pre-check blocks never reach Kiln — those rows stay at 0 tokens.
            </p>
            <AsyncView state={state} loadingLabel="Aggregating Kiln usage…">
                {({ report }) => (
                    <>
                        {report.provider === "fake" && report.totals.kilnCalls > 0 ? (
                            <p className="notice notice-warn" role="status">
                                Simulated (fake Kiln) data — no real model call was made for these rows.
                            </p>
                        ) : null}
                        <section className="card" aria-label="Usage per flow">
                            <h2>Usage per flow</h2>
                            <UsageTable report={report} />
                        </section>
                        <section className="card" aria-label="Avoided inference">
                            <h2>Avoided inference</h2>
                            <p>
                                {report.savings.ruleBlockedRequests} request{report.savings.ruleBlockedRequests === 1 ? " was" : "s were"} blocked by code rules
                                with 0 Kiln calls. At the intent-judgment average that is about {n(report.savings.avoidedTokensEstimate)} tokens and{" "}
                                {wh(report.savings.avoidedEnergyWhUpper)} Wh not spent (2-card scenario estimate).
                            </p>
                        </section>
                        <section className="card" aria-label="Energy estimate">
                            <h2>Energy estimate (2-card scenario) — not measured</h2>
                            <p className="notice notice-warn">{report.energy.disclaimer}</p>
                            <p>
                                <code>{report.energy.formula}</code>
                            </p>
                            <ul>
                                {report.energy.assumptions.map((a) => (
                                    <li key={a.name}>
                                        <strong>
                                            {a.name} = {a.value} {a.unit}
                                        </strong>{" "}
                                        — <span className="muted">{a.source}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    </>
                )}
            </AsyncView>
        </div>
    );
}
