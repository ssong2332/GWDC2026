import type { ApiError } from "./apiClient";
import { en, type Messages } from "./i18n/en";

// Code → text for every failure the screens can show (Architecture 에러 처리: API codes, client/wallet codes,
// PolicyVault custom errors surfaced by simulation before signing).
// T-17 (F-17 ⑥⑧, D-41): the screen title comes from the selected dictionary (`m.errors`). ERROR_MESSAGES is the English
// dictionary, kept as the ApiError.message diagnostic value the client itself creates (wallet / contract errors).

export const ERROR_MESSAGES: Record<string, string> = en.errors;

/**
 * Title from the selected dictionary; the server / wallet message underneath in its original text, unless it only
 * repeats the title (English or selected language). Unknown codes: generic title, `code: message` as detail.
 */
export function describeError(e: ApiError, m: Messages): { title: string; detail: string | null } {
    const table: Record<string, string> = m.errors;
    const known = Object.hasOwn(table, e.code);
    const title = known ? table[e.code] : table.INTERNAL;
    const message = e.message.trim();
    if (!known) return { title, detail: message ? `${e.code}: ${message}` : e.code };
    const repeatsTitle = message === title || message === ERROR_MESSAGES[e.code];
    return { title, detail: message && !repeatsTitle ? message : null };
}
