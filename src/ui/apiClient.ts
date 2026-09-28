// Browser JSON client for the Route Handlers (Architecture 9: `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`).
// Every outcome — including network failures and non-JSON responses — becomes one result shape.

export type ApiError = { code: string; message: string };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function badResponse(status: number, message: string): ApiResult<never> {
    return { ok: false, status, error: { code: "BAD_RESPONSE", message } };
}

export async function requestJson<T>(url: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<ApiResult<T>> {
    let res: Response;
    try {
        res = await fetchImpl(url, init);
    } catch (err) {
        return { ok: false, status: 0, error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : "network error" } };
    }
    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return badResponse(res.status, `the server returned a non-JSON response (HTTP ${res.status})`);
    }
    if (!isRecord(body)) return badResponse(res.status, "unexpected response shape");
    if (body.ok === true) {
        const { ok: _ok, ...data } = body;
        return { ok: true, data: data as T };
    }
    const e = body.error;
    if (body.ok === false && isRecord(e) && typeof e.code === "string" && typeof e.message === "string")
        return { ok: false, status: res.status, error: { code: e.code, message: e.message } };
    return badResponse(res.status, "unexpected response shape");
}

export function postJson<T>(url: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<ApiResult<T>> {
    return requestJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, fetchImpl);
}
