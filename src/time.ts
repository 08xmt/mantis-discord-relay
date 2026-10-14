import { randomBytes } from "crypto";

/** 10 minutes, shared by relay auth and the action verifier. */
export const SKEW_MS = 10 * 60 * 1000;

export const PREVIEW_TTL_MS = 5 * 60 * 1000;

export const WATCHDOG_MS = 3 * 60 * 1000;

export const RATE_WINDOW_MS = 10 * 60 * 1000;

export const USER_RATE_LIMIT = 10;

export const GLOBAL_RATE_LIMIT = 30;

/** Backoff after a failed delivery attempt, before the next try. Three retries. */
export const DELIVERY_BACKOFF_MS = [5_000, 30_000, 120_000] as const;

export const DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_MS.length + 1;

export const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

export function isoMillis(date: Date): string {
  return date.toISOString();
}

/** Seconds-precision UTC timestamp used inside signed payloads. */
export function payloadTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 128-bit nonce as 32 lowercase hex characters. */
export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

export function parseTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function withinSkew(timestamp: string, now: Date, skewMs = SKEW_MS): boolean {
  const ms = parseTimestamp(timestamp);
  if (ms === null) return false;
  return Math.abs(now.getTime() - ms) <= skewMs;
}
