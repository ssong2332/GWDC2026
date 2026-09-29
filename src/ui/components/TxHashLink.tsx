"use client";

import type { Hex } from "@/core/domain/types";
import { useI18n } from "../i18n/LocaleProvider";
import { compactHash } from "./hashText";

// Explorer link when the network has one (Base Sepolia); on the local node the hash is shown as text.
// Link accessible name = full hash (aria-label, T-16); title stays as the description with the explorer hint
// (hint in the selected language, T-17).

export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;

export function TxHashLink({ hash, explorerTxUrl, full = false }: { hash: Hex; explorerTxUrl: string | null; full?: boolean }) {
    const { m } = useI18n();
    // Abbreviated form: medium label on wide screens, compact label at <=640px (CSS toggles; the hidden one is display:none).
    const text = full ? (
        hash
    ) : (
        <>
            <span className="hash-medium">{shortHash(hash)}</span>
            <span className="hash-compact">{compactHash(hash)}</span>
        </>
    );
    if (explorerTxUrl === null)
        return (
            <code className="hash" title={hash}>
                {text}
            </code>
        );
    return (
        <a className="hash" href={`${explorerTxUrl}${hash}`} target="_blank" rel="noreferrer" aria-label={hash} title={`${hash} (${m.common.opensExplorer})`}>
            {text}
        </a>
    );
}
