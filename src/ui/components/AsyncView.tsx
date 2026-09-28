"use client";

import type { ReactNode } from "react";
import type { ApiError } from "../apiClient";
import { describeError } from "../errorMessages";
import type { ApiState } from "../hooks/useApi";

// Shared loading / empty / error rendering (Architecture 10 재사용 컴포넌트).

export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
    const { title, detail } = describeError(error);
    return (
        <div className="notice notice-error" role="alert">
            <strong>{title}</strong>
            {detail ? <span className="notice-detail">{detail}</span> : null}
            {onRetry ? (
                <button type="button" className="btn-secondary" onClick={onRetry}>
                    Retry
                </button>
            ) : null}
        </div>
    );
}

export function Loading({ label }: { label: string }) {
    return (
        <p className="loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {label}
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
