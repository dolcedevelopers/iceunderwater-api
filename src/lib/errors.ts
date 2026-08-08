export type ErrorCode =
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly expose: boolean;

  constructor(status: number, code: ErrorCode, message: string, options?: { expose?: boolean; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.expose = options?.expose ?? status < 500;
  }
}

export function authRequired(message = "Please sign in to continue."): AppError {
  return new AppError(401, "AUTH_REQUIRED", message);
}

export function accessDenied(message = "You do not have access to that."): AppError {
  return new AppError(403, "ACCESS_DENIED", message);
}

export function validationError(message: string): AppError {
  return new AppError(400, "VALIDATION_ERROR", message);
}

export function notFound(message = "Not found."): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function conflict(message: string): AppError {
  return new AppError(409, "CONFLICT", message);
}
