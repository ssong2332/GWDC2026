"use client";

import type { EfficiencyResponse } from "@/app/api/_lib/dto";
import { AsyncView } from "../components/AsyncView";
import { useApi } from "../hooks/useApi";
import { useDocumentTitle, useI18n } from "../i18n/LocaleProvider";
import { labelFor } from "../i18n/messages";

// ④ Efficiency (F-14): per-flow Kiln usage from SQLite, rule-blocked requests at 0 tokens, and the energy estimate (2-card scenario, D-38)
// with its formula and assumptions (D-20 — an estimate, not a measurement).
// T-17: the energy formula, warning, units and sources come from the dictionary (en = ENERGY_ASSUMPTIONS, ko = D-43);
// assumption values and names are the API's values. Numbers keep one format in both languages (D-42).

type Report = EfficiencyResponse["report"];

const wh = (n: number) => n.toFixed(4);
const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));

function UsageTable({ report }: { report: Report }) {
    const { m } = useI18n();
    const h = m.efficiency.table;
    const t = report.totals;
    return (
        <div className="table-wrap">
            <table>
                <caption className="sr-only">{h.caption}</caption>
                <thead>
                    <tr>
                        <th scope="col">{h.flow}</th>
                        <th scope="col" className="num">{h.kilnCalls}</th>
                        <th scope="col" className="num">{h.requests}</th>
                        <th scope="col" className="num">{h.prompt}</th>
                        <th scope="col" className="num">{h.completion}</th>
                        <th scope="col" className="num">{h.reasoning}</th>
                        <th scope="col" className="num">{h.totalTokens}</th>
                        <th scope="col" className="num">{h.cost}</th>
                        <th scope="col" className="num">{h.energy}</th>
                        <th scope="col">{m.common.generationId}</th>
                    </tr>
                </thead>
                <tbody>
                    {report.rows.length === 0 ? (
                        <tr>
                            <td colSpan={10} className="muted">
                                {h.empty}
                            </td>
                        </tr>
                    ) : (
                        report.rows.map((r) => (
                            <tr key={r.flow}>
                                <th scope="row">{labelFor(m.efficiency.flows, r.flow) ?? r.flow}</th>
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
                                            <summary>{h.ids({ count: r.generationIds.length })}</summary>
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
                        <th scope="row">{h.total}</th>
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
    const { m } = useI18n();
    const t = m.efficiency;
    useDocumentTitle(t.title);
    const state = useApi<EfficiencyResponse>("/api/efficiency");
    return (
        <div className="stack">
            <h1>{t.title}</h1>
            <p className="lead">{t.lead}</p>
            <AsyncView state={state} loadingLabel={t.loading}>
                {({ report }) => (
                    <>
                        {report.provider === "fake" && report.totals.kilnCalls > 0 ? (
                            <p className="notice notice-warn" role="status">
                                {t.fakeBanner}
                            </p>
                        ) : null}
                        <section className="card" aria-label={t.usageTitle}>
                            <h2>{t.usageTitle}</h2>
                            <UsageTable report={report} />
                        </section>
                        <section className="card" aria-label={t.avoidedTitle}>
                            <h2>{t.avoidedTitle}</h2>
                            <p>
                                {t.savings({
                                    count: report.savings.ruleBlockedRequests,
                                    tokens: n(report.savings.avoidedTokensEstimate),
                                    wh: wh(report.savings.avoidedEnergyWhUpper),
                                })}
                            </p>
                        </section>
                        <section className="card" aria-label={m.energy.title}>
                            <h2>{m.energy.title}</h2>
                            <p className="notice notice-warn">{m.energy.disclaimer}</p>
                            <p>
                                <code>{m.energy.formula}</code>
                            </p>
                            <ul>
                                {report.energy.assumptions.map((a) => (
                                    <li key={a.name}>
                                        <strong>
                                            {a.name} = {a.value} {labelFor(m.energy.units, a.name) ?? a.unit}
                                        </strong>{" "}
                                        — <span className="muted">{labelFor(m.energy.sources, a.name) ?? a.source}</span>
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
