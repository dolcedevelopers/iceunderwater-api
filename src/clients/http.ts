import { AppError } from "../lib/errors.js";

export type HttpJsonOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
};

export async function httpJson<T>(url: string, options: HttpJsonOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as T & { message?: string; code?: string };
      if (!response.ok) {
        throw new AppError(502, "UPSTREAM_ERROR", payload.message || `Upstream error ${response.status}`, {
          expose: true,
        });
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof AppError) throw lastError;
  throw new AppError(502, "UPSTREAM_ERROR", "Upstream service unreachable", { cause: lastError });
}
