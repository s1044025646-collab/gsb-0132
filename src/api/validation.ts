import { AppError } from "../errors.ts";

export function intParam(value: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AppError("VALIDATION", `Parameter '${name}' is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new AppError("VALIDATION", `Parameter '${name}' must be an integer`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new AppError("VALIDATION", `Parameter '${name}' must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new AppError("VALIDATION", `Parameter '${name}' must be <= ${opts.max}`);
  }
  return n;
}

export function optionalInt(value: unknown, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return intParam(value, name, opts);
}

export function numberParam(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AppError("VALIDATION", `Parameter '${name}' must be a finite number`);
  }
  return n;
}

export function paging(query: URLSearchParams): { limit: number; offset: number } {
  const limit = intParam(query.get("limit") ?? "50", "limit", { min: 1, max: 200 });
  const offset = intParam(query.get("offset") ?? "0", "offset", { min: 0 });
  return { limit, offset };
}

export function requireBody<T>(parsed: unknown): T {
  if (typeof parsed !== "object" || parsed === null) {
    throw new AppError("BAD_REQUEST", "Request body must be a JSON object");
  }
  return parsed as T;
}
