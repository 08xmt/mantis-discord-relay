import { STATUS_VALUES, type StatusValue } from "./crypto";

export const MESSAGE_KINDS = ["hunter_msg", "followup", "outcome", "status_change"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface SubmissionBody {
  submission_id: string;
  title: string;
  severity_claim: string;
  status: StatusValue;
  summary_md: string;
  hunter_record_md: string;
  blocked: boolean;
  hunter_label?: string;
}

export interface MessageBody {
  kind: MessageKind;
  source_id: string;
  author_label: string;
  body: string;
  created_at: string;
  related_discord_message_id?: string;
  body_sha256?: string;
  outcome?: "ok" | "failed" | "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeText(value: string, max: number): boolean {
  return value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export function validateSubmission(value: unknown): { ok: true; body: SubmissionBody } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid" };
  const id = value.submission_id;
  if (typeof id !== "string" || id.length < 1 || id.length > 128 || /[\s\u0000-\u001f\u007f]/.test(id)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof value.title !== "string" || !isSafeText(value.title, 300)) return { ok: false, error: "invalid" };
  if (typeof value.severity_claim !== "string" || !isSafeText(value.severity_claim, 200)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof value.status !== "string" || !STATUS_VALUES.includes(value.status as StatusValue)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof value.summary_md !== "string" || !isSafeText(value.summary_md, 20_000)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof value.hunter_record_md !== "string" || !isSafeText(value.hunter_record_md, 8_000)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof value.blocked !== "boolean") return { ok: false, error: "invalid" };
  let hunterLabel: string | undefined;
  if (value.hunter_label !== undefined) {
    if (typeof value.hunter_label !== "string" || !isSafeText(value.hunter_label, 200)) {
      return { ok: false, error: "invalid" };
    }
    hunterLabel = value.hunter_label;
  }
  return {
    ok: true,
    body: {
      submission_id: id,
      title: value.title,
      severity_claim: value.severity_claim,
      status: value.status as StatusValue,
      summary_md: value.summary_md,
      hunter_record_md: value.hunter_record_md,
      blocked: value.blocked,
      hunter_label: hunterLabel,
    },
  };
}

export function validateMessage(value: unknown): { ok: true; body: MessageBody } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid" };
  if (typeof value.kind !== "string" || !MESSAGE_KINDS.includes(value.kind as MessageKind)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof value.source_id !== "string" || value.source_id.length < 1 || value.source_id.length > 200) {
    return { ok: false, error: "invalid" };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(value.source_id)) return { ok: false, error: "invalid" };
  if (typeof value.author_label !== "string" || !isSafeText(value.author_label, 200)) {
    return { ok: false, error: "invalid" };
  }
  if (typeof value.body !== "string" || !isSafeText(value.body, 20_000)) return { ok: false, error: "invalid" };
  if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    return { ok: false, error: "invalid" };
  }
  const body: MessageBody = {
    kind: value.kind as MessageKind,
    source_id: value.source_id,
    author_label: value.author_label,
    body: value.body,
    created_at: value.created_at,
  };
  if (value.related_discord_message_id !== undefined) {
    if (typeof value.related_discord_message_id !== "string" || !/^\d{17,20}$/.test(value.related_discord_message_id)) {
      return { ok: false, error: "invalid" };
    }
    body.related_discord_message_id = value.related_discord_message_id;
  }
  if (value.body_sha256 !== undefined) {
    if (typeof value.body_sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.body_sha256)) {
      return { ok: false, error: "invalid" };
    }
    body.body_sha256 = value.body_sha256.toLowerCase();
  }
  if (value.outcome !== undefined) {
    if (value.outcome !== "ok" && value.outcome !== "failed" && value.outcome !== "unknown") {
      return { ok: false, error: "invalid" };
    }
    body.outcome = value.outcome;
  }
  return { ok: true, body };
}
