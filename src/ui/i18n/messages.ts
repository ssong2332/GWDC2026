import { en, type Messages } from "./en";
import { ko } from "./ko";
import { UI_LOCALE } from "@/config/constants";
import type { Locale } from "./locale";

// Locale → dictionary (F-17, D-40).

export type { Messages };

export const MESSAGES: Record<Locale, Messages> = { ko, en };

/**
 * Static layout <title> before the client applies the screen title: the default language's product name.
 * The brand itself is per language (m.common.brand); D-44 keeps the layout metadata static (no cookie-based metadata).
 */
export const DEFAULT_BRAND = MESSAGES[UI_LOCALE.default].common.brand;

/** Dictionary lookup for values the server sends as codes; values the table does not know are shown as they are (Architecture 10). */
export function labelFor(table: object, key: string | number): string | null {
    const v = (table as Record<string, unknown>)[String(key)];
    return Object.hasOwn(table, String(key)) && typeof v === "string" ? v : null;
}
