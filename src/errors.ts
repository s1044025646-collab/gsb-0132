export type ErrorCode =
  | "INVALID_FILE"
  | "UNSUPPORTED_SMPTE"
  | "TRUNCATED_FILE"
  | "UNSUPPORTED_FORMAT"
  | "NOT_FOUND"
  | "VALIDATION"
  | "OUT_OF_RANGE"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
