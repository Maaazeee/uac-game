export declare class AppError extends Error {
    statusCode: number;
    details: unknown;
    constructor(statusCode: number, message: string, details?: unknown);
}
export declare class NotFoundError extends AppError {
    constructor(message?: string);
}
export declare class ValidationError extends AppError {
    constructor(message: string, details?: unknown);
}
export declare class ForbiddenError extends AppError {
    constructor(message?: string);
}
//# sourceMappingURL=errors.d.ts.map