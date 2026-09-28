"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson, type ApiError } from "../apiClient";

// Server data state (Architecture 10): { status, data, error } with status idle · loading · success · error.
// Polling keeps the last data while refreshing, so the screen does not flash back to "loading" every interval.

export type ApiState<T> = { status: "idle" | "loading" | "success" | "error"; data: T | null; error: ApiError | null };

export function useApi<T>(url: string | null, opts: { pollMs?: number } = {}): ApiState<T> & { reload: () => void } {
    const [state, setState] = useState<ApiState<T>>({ status: "idle", data: null, error: null });
    const [tick, setTick] = useState(0);
    const inFlight = useRef(false);
    const reload = useCallback(() => setTick((t) => t + 1), []);

    useEffect(() => {
        if (url === null) {
            setState({ status: "idle", data: null, error: null });
            return;
        }
        let alive = true;
        const load = async () => {
            if (inFlight.current) return;
            inFlight.current = true;
            setState((s) => (s.data === null ? { status: "loading", data: null, error: null } : s));
            const r = await requestJson<T>(url);
            inFlight.current = false;
            if (!alive) return;
            setState((s) => (r.ok ? { status: "success", data: r.data, error: null } : { status: "error", data: s.data, error: r.error }));
        };
        void load();
        const timer = opts.pollMs ? setInterval(load, opts.pollMs) : null;
        return () => {
            alive = false;
            inFlight.current = false;
            if (timer) clearInterval(timer);
        };
    }, [url, opts.pollMs, tick]);

    return { ...state, reload };
}
