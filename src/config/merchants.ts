import type { MerchantEntry } from "@/core/domain/types";

// Demo merchant registry (Architecture 3, D-27). Fixed demo addresses — nobody holds keys for them.
export const MERCHANT_REGISTRY: MerchantEntry[] = [
    { id: "daiso", displayName: "Daiso", aliases: ["다이소", "Daiso"], address: "0x000000000000000000000000000000000000da15" },
    { id: "coupang", displayName: "Coupang", aliases: ["쿠팡", "Coupang"], address: "0x000000000000000000000000000000000000c0a9" },
    {
        id: "gmarket",
        displayName: "Gmarket",
        aliases: ["G마켓", "지마켓", "Gmarket"],
        address: "0x0000000000000000000000000000000000009a4e",
    },
];
