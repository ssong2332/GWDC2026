"use client";

import { useCallback, useRef, useState } from "react";
import { ERROR_MESSAGES } from "../errorMessages";
import { createWalletPorts, initialOwnerActionState, isBusy, runOwnerAction, type OwnerActionBody, type OwnerActionState } from "./ownerAction";
import { useWallet } from "./WalletProvider";

// React wrapper of the owner-action state machine. One action at a time: a second run while busy is ignored.

export function useOwnerAction(onDone?: (s: Extract<OwnerActionState, { step: "done" }>) => void) {
    const { provider, wallet } = useWallet();
    const [state, setState] = useState<OwnerActionState>(initialOwnerActionState);
    const [label, setLabel] = useState<string | null>(null);
    const busy = useRef(false);

    const run = useCallback(
        async (actionLabel: string, body: OwnerActionBody) => {
            if (busy.current) return;
            setLabel(actionLabel);
            if (!provider || wallet.address === null) {
                setState({ step: "error", at: "preparing", error: { code: "NO_WALLET", message: ERROR_MESSAGES.NO_WALLET }, txHash: null });
                return;
            }
            busy.current = true;
            try {
                const ports = createWalletPorts({ provider, account: wallet.address });
                const final = await runOwnerAction(ports, body, setState, { walletChainId: wallet.chainId });
                if (final.step === "done") onDone?.(final);
            } finally {
                busy.current = false;
            }
        },
        [provider, wallet.address, wallet.chainId, onDone],
    );

    const reset = useCallback(() => {
        setState(initialOwnerActionState);
        setLabel(null);
    }, []);

    return { state, label, busy: isBusy(state), run, reset };
}
