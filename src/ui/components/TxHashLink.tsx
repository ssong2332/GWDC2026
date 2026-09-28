import type { Hex } from "@/core/domain/types";

// Explorer link when the network has one (Base Sepolia); on the local node the hash is shown as text.

export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;

export function TxHashLink({ hash, explorerTxUrl, full = false }: { hash: Hex; explorerTxUrl: string | null; full?: boolean }) {
    const text = full ? hash : shortHash(hash);
    if (explorerTxUrl === null)
        return (
            <code className="hash" title={hash}>
                {text}
            </code>
        );
    return (
        <a className="hash" href={`${explorerTxUrl}${hash}`} target="_blank" rel="noreferrer" title={`${hash} (opens the block explorer)`}>
            {text}
        </a>
    );
}
