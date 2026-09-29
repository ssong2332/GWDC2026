import { describe, expect, it } from "vitest";
import { ENERGY_ASSUMPTIONS } from "@/config/constants";
import { BlockReason, PendingFlag } from "@/core/domain/reasons";
import { en } from "@/ui/i18n/en";
import { ko } from "@/ui/i18n/ko";
import { DEFAULT_BRAND, MESSAGES, labelFor } from "@/ui/i18n/messages";
import { API_CODES, CLIENT_CODES, CONTRACT_CODES } from "./helpers/errorCodes";

// F-17 ③⑥ + missing keys (Architecture 테스트 전략 "UI 언어 테스트" ④~⑨, D-43).

type Leaf = { path: string; kind: string; value: unknown };

function leaves(obj: unknown, prefix = ""): Leaf[] {
    const out: Leaf[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "object" && v !== null) out.push(...leaves(v, path));
        else out.push({ path, kind: typeof v, value: v });
    }
    return out;
}

/** One sample argument object carrying every parameter name a dictionary function uses. */
const SAMPLE = {
    chain: "Base Sepolia",
    code: 99,
    count: 2,
    name: "Emart",
    example: "example sentence",
    max: 500,
    prompt: 10,
    completion: 20,
    reasoning: "n/a",
    version: 3,
    block: "123",
    event: "SpendBlocked",
    tokens: "1,234",
    wh: "0.1234",
    budgetMin: 1,
    budgetMax: 100_000_000,
    purposeMax: 200,
    rateLimitMax: 1000,
    delegationTextMax: 500,
};
const text = (l: Leaf): string => (l.kind === "function" ? (l.value as (p: typeof SAMPLE) => string)(SAMPLE) : (l.value as string));

/** Paths whose ko value may equal en (identifiers, units, abbreviations) — each one named explicitly. */
const SAME_ALLOWED = new Set(["common.generationId", "energy.units.cardPowerW", "dashboard.table.tx"]);

const enLeaves = leaves(en);
const koLeaves = leaves(ko);
const byPath = (ls: Leaf[]) => new Map(ls.map((l) => [l.path, l]));

describe("dictionary shape (④ missing keys)", () => {
    it("ko and en have the same deep key paths", () => {
        expect(koLeaves.map((l) => l.path).sort()).toEqual(enLeaves.map((l) => l.path).sort());
    });
    it("same value type (string / function) at every path, and nothing else", () => {
        const k = byPath(koLeaves);
        for (const l of enLeaves) {
            expect(["string", "function"], l.path).toContain(l.kind);
            expect(k.get(l.path)?.kind, l.path).toBe(l.kind);
        }
    });
    it("MESSAGES maps each locale to its dictionary", () => {
        expect(MESSAGES.ko).toBe(ko);
        expect(MESSAGES.en).toBe(en);
    });
});

describe("no empty text (⑤)", () => {
    it.each([
        ["en", enLeaves],
        ["ko", koLeaves],
    ])("%s: every string and every function result is non-empty", (_l, ls) => {
        for (const l of ls) expect(text(l).trim().length, l.path).toBeGreaterThan(0);
    });
});

describe("no untranslated text (⑥)", () => {
    it("ko differs from en at every path except the named allow-list", () => {
        const e = byPath(enLeaves);
        const same = koLeaves.filter((l) => !SAME_ALLOWED.has(l.path) && text(l) === text(e.get(l.path)!)).map((l) => l.path);
        expect(same).toEqual([]);
    });
    it("the allow-list only names paths that exist", () => {
        const paths = new Set(enLeaves.map((l) => l.path));
        for (const p of SAME_ALLOWED) expect(paths.has(p), p).toBe(true);
    });
});

describe("code coverage (⑦)", () => {
    it.each([
        ["en", en],
        ["ko", ko],
    ])("%s covers every code the screens can receive", (_l, m) => {
        for (const c of [...API_CODES, ...CLIENT_CODES, ...CONTRACT_CODES]) expect(Object.keys(m.errors), c).toContain(c);
        for (let r = BlockReason.PAUSED; r <= BlockReason.INSUFFICIENT_VAULT_BALANCE; r++) expect(Object.keys(m.reasons), `reason ${r}`).toContain(String(r));
        expect(typeof m.reasons.unknown).toBe("function");
        for (const f of Object.values(PendingFlag)) expect(Object.keys(m.flags)).toContain(String(f));
        expect(Object.keys(m.activityKinds).sort()).toEqual(["approved", "blocked", "executed", "paused", "pending", "policy_set", "rejected", "unpaused"]);
        expect(Object.keys(m.judgment).sort()).toEqual(["error", "invalid_output", "match", "mismatch", "no_local_evidence", "not_judged"]);
        expect(Object.keys(m.efficiency.flows).sort()).toEqual(["intent_judge", "policy_parse", "rule_block"]);
        expect(Object.keys(m.audit.events).sort()).toEqual(["Approved", "PolicySet", "Rejected", "SpendBlocked", "SpendExecuted", "SpendPending", "VaultPaused", "VaultUnpaused"]);
        expect(Object.keys(m.wallet.gate).sort()).toEqual(["disconnected", "loading", "no_wallet", "not_owner", "wrong_chain"]);
    });
});

describe("energy text (⑧ D-43 exact strings, D-38 single source)", () => {
    it("ko energy / efficiency strings match the D-43 table character for character", () => {
        expect(ko.efficiency.table.energy).toBe("에너지 추정, 2장 시나리오 (Wh)");
        expect(ko.efficiency.savings({ count: 3, tokens: "1,234", wh: "0.5000" })).toBe(
            "코드 규칙으로 3건이 차단되어 Kiln 호출이 0회였습니다. 의도 판단 평균으로 환산하면 약 1,234 토큰과 0.5000 Wh를 쓰지 않았습니다(2장 시나리오 추정).",
        );
        expect(ko.energy.title).toBe("에너지 추정 (2장 시나리오) — 측정값 아님");
        expect(ko.energy.formula).toBe("E_Wh = latency_s × cards × P_card_W ÷ 3600 (2장 시나리오 추정: 카드 2장의 전력 전부를 이 요청에 귀속하고 배치 처리는 무시)");
        expect(ko.energy.disclaimer).toBe(
            "추정값(가정)이며 측정값이 아닙니다. 2장 시나리오: Kiln은 qwen3-32b를 몇 장의 카드로 서비스하는지 공개하지 않아 카드 수를 확정할 수 없으며, 카드가 더 많으면 값이 그에 비례해 커집니다. 지연 시간은 이 클라이언트가 측정한 값이고, 전력과 카드 수는 가정입니다.",
        );
        expect(ko.energy.units.cards).toBe("장");
        expect(ko.energy.units.cardPowerW).toBe("W");
        expect(ko.energy.sources.cards).toBe("qwen3-32b BF16 가중치 약 64 GB > FuriosaAI RNGD 카드 1장의 HBM 48 GB → 최소 2장 (가정 — Kiln의 서빙 구성은 공개되지 않음)");
        expect(ko.energy.sources.cardPowerW).toBe("FuriosaAI RNGD 공개 TDP 180 W (요청 전체 동안 최대 전력을 쓴다고 가정)");
    });
    it("en energy text is the ENERGY_ASSUMPTIONS / D-38 text", () => {
        expect(en.energy.formula).toBe(ENERGY_ASSUMPTIONS.formula);
        expect(en.energy.disclaimer).toBe(ENERGY_ASSUMPTIONS.disclaimer);
        expect(en.energy.units).toEqual({ cards: ENERGY_ASSUMPTIONS.cards.unit, cardPowerW: ENERGY_ASSUMPTIONS.cardPowerW.unit });
        expect(en.energy.sources).toEqual({ cards: ENERGY_ASSUMPTIONS.cards.source, cardPowerW: ENERGY_ASSUMPTIONS.cardPowerW.source });
        expect(en.energy.title).toBe("Energy estimate (2-card scenario) — not measured");
        expect(en.efficiency.table.energy).toBe("Energy est., 2-card scenario (Wh)");
        expect(en.efficiency.savings({ count: 1, tokens: "10", wh: "0.0010" })).toBe(
            "1 request was blocked by code rules with 0 Kiln calls. At the intent-judgment average that is about 10 tokens and 0.0010 Wh not spent (2-card scenario estimate).",
        );
        expect(en.efficiency.savings({ count: 0, tokens: "0", wh: "0.0000" })).toMatch(/^0 requests were blocked/);
    });
});

describe("no 'upper bound' wording (⑨)", () => {
    it.each([
        ["en", en],
        ["ko", ko],
    ])("%s energy + efficiency text never says upper bound / ≤ / 상한", (_l, m) => {
        for (const l of [...leaves(m.energy, "energy"), ...leaves(m.efficiency, "efficiency")]) expect(text(l), l.path).not.toMatch(/upper bound|≤|상한/i);
    });
});

describe("fixed strings named by the design (Architecture 10 설계 지정 문구)", () => {
    it("nav links, gate, signature, dashboard, audit and efficiency strings", () => {
        expect(ko.nav.links).toEqual({ delegate: "위임", dashboard: "대시보드", audit: "감사", efficiency: "효율 리포트" });
        expect(en.nav.links).toEqual({ delegate: "Delegate", dashboard: "Dashboard", audit: "Audit", efficiency: "Efficiency" });
        expect([en.nav.language, ko.nav.language]).toEqual(["Language", "언어"]);
        expect([en.wallet.connect, ko.wallet.connect]).toEqual(["Connect wallet", "지갑 연결"]);
        expect([en.wallet.switchTo({ chain: "Base Sepolia" }), ko.wallet.switchTo({ chain: "Base Sepolia" })]).toEqual(["Switch to Base Sepolia", "Base Sepolia(으)로 전환"]);
        expect([en.wallet.gate.not_owner, ko.wallet.gate.not_owner]).toEqual(["Connected address is not the owner (view only).", "연결된 주소가 소유자가 아닙니다 (조회만 가능)."]);
        expect([en.errors.SIGNATURE_REJECTED, ko.errors.SIGNATURE_REJECTED]).toEqual(["Signature rejected", "서명이 거부되었습니다"]);
        expect([en.dashboard.delegateFirst, ko.dashboard.delegateFirst]).toEqual(["Delegate first →", "먼저 위임하세요 →"]);
        expect([en.audit.notFoundStrong, ko.audit.notFoundStrong]).toEqual(["No record found", "기록 없음"]);
        expect([en.efficiency.table.empty, ko.efficiency.table.empty]).toEqual(["No Kiln calls recorded", "기록된 Kiln 호출 없음"]);
        expect(en.efficiency.fakeBanner.startsWith("Simulated (fake Kiln) data — ")).toBe(true);
        expect(ko.efficiency.fakeBanner.startsWith("시뮬레이션(가짜 Kiln) 데이터 — ")).toBe(true);
    });
});

describe("labelFor (code → label; unknown values are shown as they are)", () => {
    it("known keys (string or number) → the label, e.g. the real PolicyVault event names", () => {
        expect(labelFor(ko.audit.events, "VaultPaused")).toBe(ko.audit.events.VaultPaused);
        expect(labelFor(en.audit.events, "VaultUnpaused")).toBe("Vault resumed");
        expect(labelFor(ko.reasons, 6)).toBe(ko.reasons[6]);
    });
    it("unknown, inherited or non-string entries → null", () => {
        expect(labelFor(en.audit.events, "Paused")).toBeNull();
        expect(labelFor(ko.reasons, 0)).toBeNull();
        expect(labelFor(ko.reasons, "unknown")).toBeNull();
        expect(labelFor(ko.judgment, "toString")).toBeNull();
        expect(labelFor(ko.judgment, "")).toBeNull();
    });
});

describe("product name per language (PRD OQ #2 해결: 곳간지기 / Allowance)", () => {
    it("brand is a dictionary value, different per language", () => {
        expect(ko.common.brand).toBe("곳간지기");
        expect(en.common.brand).toBe("Allowance");
    });
    it("the static layout <title> uses the default language (ko) brand (D-44: no cookie-based metadata)", () => {
        expect(DEFAULT_BRAND).toBe("곳간지기");
    });
});
