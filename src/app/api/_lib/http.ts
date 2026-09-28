import { AppError } from "@/core/errors";
import { toJsonSafe } from "./dto";

// Error → HTTP mapping (Architecture 에러 처리 "실패가 사용자에게 드러나는 방식"). One failure shape:
// { ok: false, error: { code, message } }. Unmapped codes and non-AppErrors become a generic INTERNAL 500 —
// stack traces, library messages and RPC URLs never reach the response.

const STATUS_BY_CODE: Record<string, number> = {
    VALIDATION_FAILED: 400,
    SCHEMA_INVALID: 422,
    NO_TOOL_CALL: 422,
    INVALID_ARGS: 422,
    UNKNOWN_MERCHANT: 422,
    EXPIRY_REQUIRED: 422,
    NOT_OWNER: 403,
    NOT_FOUND: 404,
    KILN_RATE_LIMITED: 429,
    KILN_CREDIT_EXHAUSTED: 402,
    KILN_UNAVAILABLE: 502,
    KILN_AUTH: 502,
    KILN_BAD_REQUEST: 502,
    CHAIN_RPC_ERROR: 502,
};

export function httpStatusFor(code: string): number {
    return Object.hasOwn(STATUS_BY_CODE, code) ? STATUS_BY_CODE[code] : 500;
}

export function jsonOk(body: Record<string, unknown>): Response {
    return Response.json({ ok: true, ...(toJsonSafe(body) as Record<string, unknown>) });
}

export function failure(code: string, message: string): Response {
    return Response.json({ ok: false, error: { code, message } }, { status: httpStatusFor(code) });
}

/** One JSON log line (Architecture 관측성). Only codes and our own messages — never env values or library text. */
function logError(code: string, message: string): void {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "api.failed", code, message: message.slice(0, 200) }));
}

export function errorResponse(err: unknown): Response {
    if (err instanceof AppError && httpStatusFor(err.code) !== 500) return failure(err.code, err.message);
    const code = err instanceof AppError ? err.code : "INTERNAL";
    logError(code, err instanceof AppError ? err.message : "unexpected error");
    return failure("INTERNAL", "Internal server error");
}

/** Reads a JSON request body; a missing or malformed body is a VALIDATION_FAILED input error. */
export async function readJsonBody(req: Request): Promise<unknown> {
    try {
        return await req.json();
    } catch {
        throw new AppError("VALIDATION_FAILED", "request body must be JSON");
    }
}
