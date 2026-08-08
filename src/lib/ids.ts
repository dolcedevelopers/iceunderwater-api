import { randomBytes } from "node:crypto";

/** Prefixed opaque ids matching the app's seed style (sup-…, drv-…, etc.). */
export function makeId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `${prefix}-${stamp}${rand}`;
}

export function normalizeEmail(value: string): string {
  return String(value || "").trim().toLowerCase();
}
