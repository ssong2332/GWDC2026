import { describe, expect, it } from "vitest";
import { postJson, requestJson } from "@/ui/apiClient";

// Browser-side JSON client (Architecture 10 "서버 데이터 상태"): every outcome becomes one result shape.

const respond = (status: number, body: unknown, raw = false) =>
    (async () => new Response(raw ? (body as string) : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("requestJson", () => {
    it("ok:true body → data without the ok flag", async () => {
        const r = await requestJson<{ items: number[] }>("/api/x", undefined, respond(200, { ok: true, items: [1, 2] }));
        expect(r).toEqual({ ok: true, data: { items: [1, 2] } });
    });

    it("ok:false body → the server's error code and message with the HTTP status", async () => {
        const r = await requestJson("/api/x", undefined, respond(403, { ok: false, error: { code: "NOT_OWNER", message: "not owner" } }));
        expect(r).toEqual({ ok: false, status: 403, error: { code: "NOT_OWNER", message: "not owner" } });
    });

    it("network failure → NETWORK_ERROR, status 0", async () => {
        const failing = (async () => {
            throw new TypeError("Failed to fetch");
        }) as unknown as typeof fetch;
        const r = await requestJson("/api/x", undefined, failing);
        expect(r).toMatchObject({ ok: false, status: 0, error: { code: "NETWORK_ERROR" } });
    });

    it("non-JSON body (e.g. an HTML error page) → BAD_RESPONSE", async () => {
        const r = await requestJson("/api/x", undefined, respond(500, "<html>oops</html>", true));
        expect(r).toMatchObject({ ok: false, status: 500, error: { code: "BAD_RESPONSE" } });
    });

    it("JSON without the ok flag or with a malformed error → BAD_RESPONSE", async () => {
        expect(await requestJson("/api/x", undefined, respond(200, { items: [] }))).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
        expect(await requestJson("/api/x", undefined, respond(400, { ok: false, error: "nope" }))).toMatchObject({
            ok: false,
            error: { code: "BAD_RESPONSE" },
        });
        expect(await requestJson("/api/x", undefined, respond(200, null))).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
    });
});

describe("postJson", () => {
    it("sends a JSON POST and returns the parsed result", async () => {
        let seen: { url: string; init: RequestInit | undefined } | null = null;
        const spy = (async (url: string, init?: RequestInit) => {
            seen = { url, init };
            return new Response(JSON.stringify({ ok: true, n: "1" }), { status: 200 });
        }) as unknown as typeof fetch;
        const r = await postJson<{ n: string }>("/api/y", { a: 1 }, spy);
        expect(r).toEqual({ ok: true, data: { n: "1" } });
        expect(seen!.url).toBe("/api/y");
        expect(seen!.init?.method).toBe("POST");
        expect(new Headers(seen!.init?.headers).get("content-type")).toBe("application/json");
        expect(JSON.parse(String(seen!.init?.body))).toEqual({ a: 1 });
    });
});
