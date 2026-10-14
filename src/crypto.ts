import { createHash, createHmac, timingSafeEqual } from "crypto";
import { parseTimestamp, SKEW_MS, withinSkew } from "./time";

export const STATUS_VALUES = [
  "new",
  "acknowledged",
  "accepted",
  "rejected",
  "duplicate",
  "paid",
  "closed",
] as const;

export type StatusValue = (typeof STATUS_VALUES)[number];

export const ACTION_NAMES = ["reply", "note", "status", "open"] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionPayload {
  v: 1;
  submission_id: string;
  action: ActionName;
  text: string;
  status?: StatusValue;
  discord_user_id: string;
  discord_message_id: string;
  discord_thread_id: string;
  timestamp: string;
  nonce: string;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

export function signaturesMatch(expectedHex: string, presentedHex: string): boolean {
  const left = Buffer.from(expectedHex.toLowerCase(), "utf8");
  const right = Buffer.from(presentedHex.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Constant-time check against every configured secret. A matching later secret
 * does not skip the remaining comparisons.
 */
export function verifyHmac(secrets: readonly string[], message: string, presentedHex: string): boolean {
  const usable = secrets.filter((secret) => secret.length > 0);
  if (!/^[0-9a-fA-F]{64}$/.test(presentedHex)) {
    for (const secret of usable) {
      signaturesMatch(hmacSha256Hex(secret, message), "0".repeat(64));
    }
    return false;
  }
  let ok = false;
  for (const secret of usable) {
    if (signaturesMatch(hmacSha256Hex(secret, message), presentedHex)) ok = true;
  }
  return ok;
}

export function relayStringToSign(timestamp: string, nonce: string, rawBody: string): string {
  return `${timestamp}.${nonce}.${rawBody}`;
}

export interface CanonicalInput {
  submission_id: string;
  action: ActionName;
  text: string;
  status?: StatusValue;
  discord_user_id: string;
  discord_message_id: string;
  discord_thread_id: string;
  timestamp: string;
  nonce: string;
}

/** Exact payload string the signature covers. Key order is fixed. */
export function canonicalActionPayload(input: CanonicalInput): string {
  const ordered: Record<string, string | number> = {
    v: 1,
    submission_id: input.submission_id,
    action: input.action,
    text: input.text,
  };
  if (input.action === "status") {
    if (!input.status) {
      throw new Error("status action requires status");
    }
    ordered.status = input.status;
  }
  ordered.discord_user_id = input.discord_user_id;
  ordered.discord_message_id = input.discord_message_id;
  ordered.discord_thread_id = input.discord_thread_id;
  ordered.timestamp = input.timestamp;
  ordered.nonce = input.nonce;
  return JSON.stringify(ordered);
}

export function signActionEnvelope(secret: string, payload: string): { payload: string; sig: string } {
  return { payload, sig: hmacSha256Hex(secret, payload) };
}

export type VerifyError =
  | "bad_signature"
  | "replay"
  | "invalid";

export interface VerifyOk {
  ok: true;
  payload: ActionPayload;
}

export interface VerifyFail {
  ok: false;
  error: VerifyError;
}

const BODY_MAX = 16_000;
const STATUS_NOTE_MAX = 4_000;

export function validateActionPayload(value: unknown): { ok: true; payload: ActionPayload } | { ok: false; error: "invalid" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "invalid" };
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return { ok: false, error: "invalid" };
  if (typeof row.submission_id !== "string" || !isId(row.submission_id, 128)) return { ok: false, error: "invalid" };
  if (typeof row.action !== "string" || !ACTION_NAMES.includes(row.action as ActionName)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof row.text !== "string") return { ok: false, error: "invalid" };
  const action = row.action as ActionName;
  const textLimit = action === "status" ? STATUS_NOTE_MAX : BODY_MAX;
  if (row.text.length > textLimit) return { ok: false, error: "invalid" };
  if ((action === "reply" || action === "note") && row.text.trim().length === 0) {
    return { ok: false, error: "invalid" };
  }
  if (action === "open" && row.text.length !== 0) return { ok: false, error: "invalid" };

  let status: StatusValue | undefined;
  if (action === "status") {
    if (typeof row.status !== "string" || !STATUS_VALUES.includes(row.status as StatusValue)) {
      return { ok: false, error: "invalid" };
    }
    status = row.status as StatusValue;
  } else if (row.status !== undefined) {
    return { ok: false, error: "invalid" };
  }

  if (typeof row.discord_user_id !== "string" || !/^\d{17,20}$/.test(row.discord_user_id)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof row.discord_message_id !== "string" || !/^\d{17,20}$/.test(row.discord_message_id)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof row.discord_thread_id !== "string" || !/^\d{17,20}$/.test(row.discord_thread_id)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof row.timestamp !== "string" || parseTimestamp(row.timestamp) === null) {
    return { ok: false, error: "invalid" };
  }
  if (typeof row.nonce !== "string" || !/^[0-9a-f]{32}$/.test(row.nonce)) {
    return { ok: false, error: "invalid" };
  }

  const payload: ActionPayload = {
    v: 1,
    submission_id: row.submission_id,
    action,
    text: row.text,
    discord_user_id: row.discord_user_id,
    discord_message_id: row.discord_message_id,
    discord_thread_id: row.discord_thread_id,
    timestamp: row.timestamp,
    nonce: row.nonce,
  };
  if (status) payload.status = status;
  return { ok: true, payload };
}

function isId(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max && !/[\s\u0000-\u001f\u007f]/.test(value);
}

export function verifyActionEnvelope(
  envelope: unknown,
  secrets: readonly string[],
  options: {
    now: Date;
    nonceSeen: (nonce: string) => boolean;
    skewMs?: number;
  },
): VerifyOk | VerifyFail {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, error: "invalid" };
  }
  const row = envelope as Record<string, unknown>;
  if (typeof row.payload !== "string" || typeof row.sig !== "string") {
    return { ok: false, error: "invalid" };
  }
  if (!verifyHmac(secrets, row.payload, row.sig)) {
    return { ok: false, error: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return { ok: false, error: "invalid" };
  }
  const validated = validateActionPayload(parsed);
  if (!validated.ok) return validated;
  if (!withinSkew(validated.payload.timestamp, options.now, options.skewMs ?? SKEW_MS)) {
    return { ok: false, error: "invalid" };
  }
  if (options.nonceSeen(validated.payload.nonce)) {
    return { ok: false, error: "replay" };
  }
  return validated;
}
