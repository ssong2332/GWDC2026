import type { ApiError } from "./apiClient";

// Code → English text for every failure the screens can show (Architecture 에러 처리: API codes, client/wallet codes,
// PolicyVault custom errors surfaced by simulation before signing).

export const ERROR_MESSAGES: Record<string, string> = {
    VALIDATION_FAILED: "The request was not valid.",
    SCHEMA_INVALID: "The policy values are out of range — nothing was applied.",
    NO_TOOL_CALL: "Kiln did not return a policy — nothing was applied. Try rephrasing the sentence.",
    INVALID_ARGS: "Kiln returned malformed policy arguments — nothing was applied.",
    UNKNOWN_MERCHANT: "The policy names a merchant that is not in the registry — nothing was applied.",
    EXPIRY_REQUIRED: "An expiry date is required.",
    NOT_OWNER: "The connected address is not the vault owner.",
    NOT_FOUND: "Not found.",
    KILN_RATE_LIMITED: "Kiln rate limit reached (429). Wait a moment and try again.",
    KILN_CREDIT_EXHAUSTED: "Kiln credits are exhausted (402). No policy was created.",
    KILN_UNAVAILABLE: "Kiln is unavailable right now. Try again later.",
    KILN_AUTH: "Kiln rejected the server's API key.",
    KILN_BAD_REQUEST: "Kiln rejected the request.",
    CHAIN_RPC_ERROR: "Could not read the blockchain (RPC error).",
    INTERNAL: "Something went wrong on the server.",
    NETWORK_ERROR: "Could not reach the local server.",
    BAD_RESPONSE: "The server returned an unexpected response.",
    NO_WALLET: "No browser wallet found. Install a wallet extension such as MetaMask.",
    SIGNATURE_REJECTED: "Signature rejected",
    WRONG_NETWORK: "The wallet is on a different network.",
    WALLET_ERROR: "The wallet reported an error.",
    TX_REVERTED: "The transaction was mined but reverted.",
    CONTRACT_NOT_OWNER: "PolicyVault: only the owner can do this.",
    CONTRACT_PENDING_EXISTS: "PolicyVault: approve or reject the pending requests before registering a new policy.",
    CONTRACT_PENDING_NOT_FOUND: "PolicyVault: this request is no longer pending.",
    CONTRACT_VAULT_IS_PAUSED: "PolicyVault: the vault is paused.",
    CONTRACT_POLICY_EXPIRED: "PolicyVault: the policy has expired.",
    CONTRACT_ALREADY_PAUSED: "PolicyVault: the vault is already paused.",
    CONTRACT_NOT_PAUSED: "PolicyVault: the vault is not paused.",
    CONTRACT_INVALID_POLICY: "PolicyVault rejected a policy field.",
    CONTRACT_REVERTED: "PolicyVault would revert this transaction.",
};

/** Headline from the table; the specific message underneath unless it only repeats the headline. */
export function describeError(e: ApiError): { title: string; detail: string | null } {
    const known = Object.hasOwn(ERROR_MESSAGES, e.code);
    const title = known ? ERROR_MESSAGES[e.code] : ERROR_MESSAGES.INTERNAL;
    const message = e.message.trim();
    if (!known) return { title, detail: message ? `${e.code}: ${message}` : e.code };
    return { title, detail: message && message !== title ? message : null };
}
