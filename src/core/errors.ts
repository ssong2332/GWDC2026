/** Error shape shared by adapters and use cases (Architecture 에러 처리). */
export class AppError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable = false,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "AppError";
    }
}
