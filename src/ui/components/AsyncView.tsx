"use client";

import type { ReactNode } from "react";
import type { ApiError } from "../apiClient";
import { describeError } from "../errorMessages";
import type { ApiState } from "../hooks/useApi";
import { useI18n } from "../i18n/LocaleProvider";

// Shared loading / empty / error rendering (Architecture 10 재사용 컴포넌트).
// Error title in the selected language; the server / wallet detail stays in its original English (F-17 ⑧, D-41).

export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
    const { m } = useI18n();
    const { title, detail } = describeError(error, m);
    return (
        <div className="notice notice-error" role="alert">
            <strong>{title}</strong>
            {detail ? (
                <span className="notice-detail" lang="en">
                    {detail}
                </span>
            ) : null}
            {onRetry ? (
                <button type="button" className="btn-secondary" onClick={onRetry}>
                    {m.common.retry}
                </button>
            ) : null}
        </div>
    );
}

/** `label` defaults to the dictionary's generic "Loading…" (server components such as a Suspense fallback cannot pick the language). */
export function Loading({ label }: { label?: string }) {
    const { m } = useI18n();
    return (
        <p className="loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {label ?? m.common.loading}
        </p>
    );
}

type Props<T> = {
    state: ApiState<T> & { reload?: () => void };
    loadingLabel: string;
    isEmpty?: (data: T) => boolean;
    empty?: ReactNode;
    children: (data: T) => ReactNode;
};

/** Loading until the first data; an error keeps the last data visible under the error notice. */
export function AsyncView<T>({ state, loadingLabel, isEmpty, empty, children }: Props<T>) {
    const { data, error } = state;
    return (
        <>
            {error ? <ErrorNotice error={error} onRetry={state.reload} /> : null}
            {data === null ? (error ? null : <Loading label={loadingLabel} />) : isEmpty?.(data) ? empty : children(data)}
        </>
    );
}
