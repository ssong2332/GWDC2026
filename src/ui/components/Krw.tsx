// Amounts are mKRW test-token units, 1 mKRW = 1 KRW (D-05).
export function formatKrw(value: string | bigint): string {
    return `₩${BigInt(value).toLocaleString("en-US")}`;
}

export function Krw({ value }: { value: string | bigint | null }) {
    if (value === null) return <span className="muted">—</span>;
    return <span className="num">{formatKrw(value)}</span>;
}
