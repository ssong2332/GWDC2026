import { describe, expect, it } from "vitest";
import { confirmBodySchema, parseBodySchema, prepareBodySchema, toJsonSafe } from "@/app/api/_lib/dto";
import { errorResponse, httpStatusFor, jsonOk } from "@/app/api/_lib/http";
import { AppError } from "@/core/errors";

// Route Handler plumbing (Architecture 9 HTTP API, 에러 처리 "실패가 사용자에게 드러나는 방식").

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const REQ = `0x${"ab".repeat(32)}`;

describe("httpStatusFor — AppError.code → HTTP status (Architecture 에러 처리 table)", () => {
    it.each([
        ["VALIDATION_FAILED", 400],
        ["SCHEMA_INVALID", 422],
        ["NO_TOOL_CALL", 422],
        ["INVALID_ARGS", 422],
        ["UNKNOWN_MERCHANT", 422],
        ["EXPIRY_REQUIRED", 422],
        ["NOT_OWNER", 403],
        ["NOT_FOUND", 404],
        ["KILN_RATE_LIMITED", 429],
        ["KILN_CREDIT_EXHAUSTED", 402],
        ["KILN_UNAVAILABLE", 502],
        ["KILN_AUTH", 502],
        ["KILN_BAD_REQUEST", 502],
        ["CHAIN_RPC_ERROR", 502],
    ])("%s → %i", (code, status) => {
        expect(httpStatusFor(code)).toBe(status);
    });

    it.each(["DEPLOYMENT_NOT_FOUND", "PRIVATE_KEY_IN_SERVER_ENV", "", "INTERNAL"])("anything else (%j) → 500", (code) => {
        expect(httpStatusFor(code)).toBe(500);
    });
});

describe("errorResponse — one failure shape, no internals leaked", () => {
    it("a mapped AppError keeps its code and message", async () => {
        const res = errorResponse(new AppError("NOT_OWNER", "the connected address is not the vault owner"));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ ok: false, error: { code: "NOT_OWNER", message: "the connected address is not the vault owner" } });
    });

    it("an unmapped AppError becomes INTERNAL with a generic message (the original text is not sent)", async () => {
        const res = errorResponse(new AppError("DEPLOYMENT_NOT_FOUND", "no deployment file at C:\\secret\\path.json"));
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body).toEqual({ ok: false, error: { code: "INTERNAL", message: "Internal server error" } });
        expect(JSON.stringify(body)).not.toContain("secret");
    });

    it("a plain Error (e.g. a library error with an RPC URL) becomes INTERNAL without the message or stack", async () => {
        const res = errorResponse(new Error("fetch failed https://base-sepolia.example/v2/KEY123"));
        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).not.toContain("KEY123");
    });

    it("non-Error throwables are handled too", async () => {
        expect(errorResponse("boom").status).toBe(500);
        expect(errorResponse(undefined).status).toBe(500);
    });
});

describe("jsonOk / toJsonSafe — bigint → decimal string", () => {
    it("serialises nested bigints and keeps other values", async () => {
        const res = jsonOk({ a: 1n, b: [2n, { c: 3n }], d: null, e: "x", f: 0n, g: 12345678901234567890n });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, a: "1", b: ["2", { c: "3" }], d: null, e: "x", f: "0", g: "12345678901234567890" });
    });

    it("toJsonSafe leaves the input untouched", () => {
        const input = { x: 5n };
        expect(toJsonSafe(input)).toEqual({ x: "5" });
        expect(input.x).toBe(5n);
    });
});

describe("request body schemas (external input validation)", () => {
    it("parse: delegationText must be a string", () => {
        expect(parseBodySchema.safeParse({ delegationText: "행사비 20만 원" }).success).toBe(true);
        expect(parseBodySchema.safeParse({ delegationText: 5 }).success).toBe(false);
        expect(parseBodySchema.safeParse({}).success).toBe(false);
    });

    const policyBody = {
        kind: "policy_set",
        owner: OWNER,
        parseCallId: "call-1",
        delegationText: "text",
        final: {
            budget: "200000",
            approvalThreshold: "50000",
            expiresAt: 1_900_000_000,
            maxPerMinute: 3,
            maxPerDay: 20,
            merchantIds: ["daiso"],
            purpose: "Party",
        },
        expiresAtSource: "owner",
        ownerEdits: ["expiresAt"],
    };

    it("prepare policy_set: amounts arrive as decimal strings and become bigint", () => {
        const r = prepareBodySchema.safeParse(policyBody);
        expect(r.success).toBe(true);
        if (r.success && r.data.kind === "policy_set") {
            expect(r.data.final.budget).toBe(200_000n);
            expect(r.data.final.approvalThreshold).toBe(50_000n);
            expect(r.data.owner).toBe(OWNER);
        }
    });

    it.each([
        ["negative amount", { final: { ...policyBody.final, budget: "-1" } }],
        ["fractional amount", { final: { ...policyBody.final, budget: "1.5" } }],
        ["number instead of string", { final: { ...policyBody.final, budget: 200000 } }],
        ["absurdly long amount", { final: { ...policyBody.final, budget: "9".repeat(40) } }],
        ["bad owner address", { owner: "0x1234" }],
        ["unknown expiresAtSource", { expiresAtSource: "ai" }],
        ["non-integer expiresAt", { final: { ...policyBody.final, expiresAt: 1.5 } }],
    ])("prepare policy_set rejects %s", (_name, over) => {
        expect(prepareBodySchema.safeParse({ ...policyBody, ...over }).success).toBe(false);
    });

    it("prepare approval / rejection need a 32-byte request id", () => {
        expect(prepareBodySchema.safeParse({ kind: "approval", owner: OWNER, requestId: REQ }).success).toBe(true);
        expect(prepareBodySchema.safeParse({ kind: "rejection", owner: OWNER, requestId: REQ }).success).toBe(true);
        expect(prepareBodySchema.safeParse({ kind: "approval", owner: OWNER, requestId: "0xab" }).success).toBe(false);
    });

    it("prepare pause accepts an empty note; unpause is not offered by the UI API", () => {
        expect(prepareBodySchema.safeParse({ kind: "pause", owner: OWNER, note: "" }).success).toBe(true);
        expect(prepareBodySchema.safeParse({ kind: "unpause", owner: OWNER, note: "" }).success).toBe(false);
    });

    it("confirm: evidenceId + 32-byte tx hash", () => {
        expect(confirmBodySchema.safeParse({ evidenceId: "ev-1", txHash: REQ }).success).toBe(true);
        expect(confirmBodySchema.safeParse({ evidenceId: "", txHash: REQ }).success).toBe(false);
        expect(confirmBodySchema.safeParse({ evidenceId: "ev-1", txHash: "0x12" }).success).toBe(false);
    });
});
