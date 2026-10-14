import { isAllowlisted } from "./allowlist";
import {
  ACTION_NAMES,
  STATUS_VALUES,
  sha256Hex,
  type ActionName,
  type StatusValue,
} from "./crypto";
import type { AuditRecord, PendingAction, Store } from "./store";
import {
  GLOBAL_RATE_LIMIT,
  PREVIEW_TTL_MS,
  RATE_WINDOW_MS,
  USER_RATE_LIMIT,
  isoMillis,
} from "./time";

const BODY_MAX = 16_000;
const STATUS_NOTE_MAX = 4_000;

export interface ActionDeps {
  store: Store;
  allowlist: ReadonlySet<string>;
  now?: () => Date;
  previewTtlMs?: number;
  onAudit?: (entry: AuditRecord) => void;
}

export interface PrepareInput {
  threadId: string;
  userId: string;
  action: ActionName;
  text: string;
  status?: StatusValue;
}

export interface PreparedPreview {
  ok: true;
  submissionId: string;
  threadId: string;
  title: string;
  hunterLabel: string;
  blocked: boolean;
  action: ActionName;
  status?: StatusValue;
  text: string;
  textSha256: string;
  visibleToHunter: boolean;
  expiresAt: string;
}

export interface ActionFailure {
  ok: false;
  error: string;
  code:
    | "not_thread"
    | "not_allowlisted"
    | "rate_limited"
    | "in_flight"
    | "too_long"
    | "bad_status"
    | "bad_action"
    | "not_blocked"
    | "blocked"
    | "empty_text"
    | "wrong_user"
    | "expired"
    | "not_found"
    | "already_handled"
    | "thread_mismatch"
    | "not_retryable";
}

export class ActionService {
  constructor(private readonly deps: ActionDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private audit(entry: Omit<AuditRecord, "ts"> & { ts?: string }): void {
    const record: AuditRecord = {
      ts: entry.ts ?? isoMillis(this.now()),
      discordUserId: entry.discordUserId,
      action: entry.action,
      submissionId: entry.submissionId,
      text: entry.text,
      textSha256: entry.textSha256,
      outcome: entry.outcome,
    };
    this.deps.store.appendAudit(record);
    try {
      this.deps.onAudit?.(record);
    } catch {
      // Audit mirroring must not roll back the SQLite record.
    }
  }

  prepare(input: PrepareInput): PreparedPreview | ActionFailure {
    if (!ACTION_NAMES.includes(input.action)) return { ok: false, code: "bad_action", error: "Unknown action." };
    const thread = this.deps.store.getThreadByThreadId(input.threadId);
    if (!thread) {
      return { ok: false, code: "not_thread", error: "This command only works inside a Mantis submission thread." };
    }
    if (!isAllowlisted(this.deps.allowlist, input.userId)) {
      return { ok: false, code: "not_allowlisted", error: "You are not on the Discord allowlist." };
    }
    const text = input.text ?? "";
    if ((input.action === "reply" || input.action === "note") && text.trim().length === 0) {
      return { ok: false, code: "empty_text", error: "Text is required." };
    }
    if (input.action === "open" && text.length !== 0) {
      return { ok: false, code: "bad_action", error: "/open does not take text." };
    }
    const limit = input.action === "status" ? STATUS_NOTE_MAX : BODY_MAX;
    if (text.length > limit) {
      return { ok: false, code: "too_long", error: `Text is longer than ${limit} characters.` };
    }
    if (input.action === "status") {
      if (!input.status || !STATUS_VALUES.includes(input.status)) {
        return { ok: false, code: "bad_status", error: "Status must be one of the allowed values." };
      }
    } else if (input.status) {
      return { ok: false, code: "bad_status", error: "Status is only valid on /status." };
    }
    if (thread.blocked && input.action !== "open" && input.action !== "note") {
      return {
        ok: false,
        code: "blocked",
        error: "This submission is blocked. Only /open and /note are allowed until a human opens it.",
      };
    }
    if (input.action === "open" && !thread.blocked) {
      return { ok: false, code: "not_blocked", error: "/open is only for flagged-hunter stubs." };
    }
    const rate = this.rateLimit(input.userId);
    if (rate) return rate;
    if (this.deps.store.countInFlight(thread.submissionId) > 0) {
      return { ok: false, code: "in_flight", error: "Another action is already in flight for this submission." };
    }
    const now = this.now();
    return {
      ok: true,
      submissionId: thread.submissionId,
      threadId: thread.threadId,
      title: thread.title,
      hunterLabel: thread.hunterLabel ?? "unknown",
      blocked: thread.blocked,
      action: input.action,
      status: input.status,
      text,
      textSha256: sha256Hex(text),
      visibleToHunter: input.action === "reply" || input.action === "status",
      expiresAt: isoMillis(new Date(now.getTime() + (this.deps.previewTtlMs ?? PREVIEW_TTL_MS))),
    };
  }

  commitPreview(messageId: string, prepared: PreparedPreview, userId: string): ActionFailure | { ok: true } {
    const again = this.prepare({
      threadId: prepared.threadId,
      userId,
      action: prepared.action,
      text: prepared.text,
      status: prepared.status,
    });
    if (!again.ok) return again;
    if (again.text !== prepared.text || again.submissionId !== prepared.submissionId) {
      return { ok: false, code: "thread_mismatch", error: "The thread mapping changed. Run the command again." };
    }
    this.deps.store.insertPreview({
      discordMessageId: messageId,
      submissionId: prepared.submissionId,
      discordUserId: userId,
      action: prepared.action,
      statusValue: prepared.status ?? null,
      text: prepared.text,
      textSha256: prepared.textSha256,
      createdAt: isoMillis(this.now()),
      expiresAt: prepared.expiresAt,
    });
    this.audit({
      discordUserId: userId,
      action: prepared.action,
      submissionId: prepared.submissionId,
      text: prepared.text,
      textSha256: prepared.textSha256,
      outcome: "preview",
    });
    return { ok: true };
  }

  confirmSend(messageId: string, userId: string, channelId: string): ActionFailure | { ok: true; action: PendingAction } {
    const now = this.now();
    const run = this.deps.store.db.transaction(() => {
      const row = this.deps.store.getAction(messageId);
      if (!row) return { ok: false as const, code: "not_found" as const, error: "This preview is no longer active." };
      if (row.discordUserId !== userId) {
        return { ok: false as const, code: "wrong_user" as const, error: "Only the person who opened this preview can send it." };
      }
      if (row.state !== "preview") {
        return { ok: false as const, code: "already_handled" as const, error: "This preview was already used." };
      }
      if (row.expiresAt <= isoMillis(now)) {
        this.deps.store.transition(messageId, ["preview"], "expired", { resolvedAt: isoMillis(now) });
        return { ok: false as const, code: "expired" as const, error: "This preview expired. Run the command again." };
      }
      const gate = this.recheck(row, userId, channelId);
      if (gate) return gate;
      const changed = this.deps.store.transition(messageId, ["preview"], "queued", {
        queuedAt: isoMillis(now),
        lastError: null,
      });
      if (!changed) {
        return { ok: false as const, code: "already_handled" as const, error: "This preview was already used." };
      }
      const updated = this.deps.store.getAction(messageId);
      if (!updated) return { ok: false as const, code: "not_found" as const, error: "This preview is no longer active." };
      return { ok: true as const, action: updated };
    });
    const result = run.immediate();
    if (!result.ok) {
      if (result.code === "expired") {
        const row = this.deps.store.getAction(messageId);
        if (row) {
          this.audit({
            discordUserId: userId,
            action: row.action,
            submissionId: row.submissionId,
            text: row.text,
            textSha256: row.textSha256,
            outcome: "expired",
          });
        }
      }
      return result;
    }
    this.audit({
      discordUserId: userId,
      action: result.action.action,
      submissionId: result.action.submissionId,
      text: result.action.text,
      textSha256: result.action.textSha256,
      outcome: "queued",
    });
    return result;
  }

  cancel(messageId: string, userId: string): ActionFailure | { ok: true } {
    const now = this.now();
    const row = this.deps.store.getAction(messageId);
    if (!row) return { ok: false, code: "not_found", error: "This preview is no longer active." };
    if (row.discordUserId !== userId) {
      return { ok: false, code: "wrong_user", error: "Only the person who opened this preview can cancel it." };
    }
    if (row.state !== "preview") {
      return { ok: false, code: "already_handled", error: "This preview was already used." };
    }
    if (row.expiresAt <= isoMillis(now)) {
      this.deps.store.transition(messageId, ["preview"], "expired", { resolvedAt: isoMillis(now) });
      this.audit({
        discordUserId: userId,
        action: row.action,
        submissionId: row.submissionId,
        text: row.text,
        textSha256: row.textSha256,
        outcome: "expired",
      });
      return { ok: false, code: "expired", error: "This preview expired. Run the command again." };
    }
    const changed = this.deps.store.transition(messageId, ["preview"], "cancelled", { resolvedAt: isoMillis(now) });
    if (!changed) return { ok: false, code: "already_handled", error: "This preview was already used." };
    this.audit({
      discordUserId: userId,
      action: row.action,
      submissionId: row.submissionId,
      text: row.text,
      textSha256: row.textSha256,
      outcome: "cancelled",
    });
    return { ok: true };
  }

  beginRetry(messageId: string, userId: string, channelId: string): ActionFailure | { ok: true; action: PendingAction } {
    if (!isAllowlisted(this.deps.allowlist, userId)) {
      return { ok: false, code: "not_allowlisted", error: "You are not on the Discord allowlist." };
    }
    const row = this.deps.store.getAction(messageId);
    if (!row) return { ok: false, code: "not_found", error: "Unknown action." };
    if (row.state === "done") return { ok: false, code: "already_handled", error: "This action is already confirmed." };
    if (row.state !== "queued" && row.state !== "delivered" && row.state !== "failed") {
      return { ok: false, code: "not_retryable", error: "This action cannot be retried." };
    }
    const gate = this.recheck(row, row.discordUserId, channelId, { skipRateLimit: true, skipInFlight: true });
    if (gate) return gate;
    if (row.state === "failed") {
      const changed = this.deps.store.transition(messageId, ["failed"], "queued", {
        queuedAt: row.queuedAt ?? isoMillis(this.now()),
        resolvedAt: null,
        lastError: null,
        watchdogPosted: false,
      });
      if (!changed) return { ok: false, code: "already_handled", error: "This action changed while retrying." };
    }
    const updated = this.deps.store.getAction(messageId);
    if (!updated) return { ok: false, code: "not_found", error: "Unknown action." };
    this.audit({
      discordUserId: userId,
      action: updated.action,
      submissionId: updated.submissionId,
      text: updated.text,
      textSha256: updated.textSha256,
      outcome: "retry",
    });
    return { ok: true, action: updated };
  }

  markDelivered(messageId: string): void {
    const row = this.deps.store.getAction(messageId);
    if (!row) return;
    const changed = this.deps.store.transition(messageId, ["queued", "delivered"], "delivered", { lastError: null });
    if (!changed) return;
    this.audit({
      discordUserId: row.discordUserId,
      action: row.action,
      submissionId: row.submissionId,
      text: row.text,
      textSha256: row.textSha256,
      outcome: "delivered",
    });
  }

  markDeliveryFailed(messageId: string, errorClass: string): PendingAction | undefined {
    const row = this.deps.store.getAction(messageId);
    if (!row) return undefined;
    const changed = this.deps.store.transition(messageId, ["queued", "delivered"], "failed", {
      resolvedAt: isoMillis(this.now()),
      lastError: errorClass,
    });
    if (!changed) return this.deps.store.getAction(messageId);
    this.audit({
      discordUserId: row.discordUserId,
      action: row.action,
      submissionId: row.submissionId,
      text: row.text,
      textSha256: row.textSha256,
      outcome: `failed:${errorClass}`,
    });
    return this.deps.store.getAction(messageId);
  }

  noteAttempt(messageId: string, errorClass: string | null): void {
    this.deps.store.noteAttempt(messageId, errorClass);
  }

  setLastError(messageId: string, errorClass: string): void {
    this.deps.store.setLastError(messageId, errorClass);
  }

  recordOutcome(input: {
    relatedDiscordMessageId: string;
    bodySha256?: string;
    outcome?: "ok" | "failed" | "unknown";
  }): { found: boolean; hashMismatch: boolean; alreadyResolved: boolean } {
    const row = this.deps.store.getAction(input.relatedDiscordMessageId);
    if (!row) return { found: false, hashMismatch: false, alreadyResolved: false };
    const reported = input.bodySha256?.toLowerCase();
    const hashMismatch = reported !== undefined && reported !== row.textSha256.toLowerCase();
    if (hashMismatch && reported) {
      this.audit({
        discordUserId: row.discordUserId,
        action: row.action,
        submissionId: row.submissionId,
        text: row.text,
        textSha256: row.textSha256,
        outcome: `hash_mismatch:${reported}`,
      });
    }
    if (!input.outcome) return { found: true, hashMismatch, alreadyResolved: row.state === "done" };
    if (row.state === "done") return { found: true, hashMismatch, alreadyResolved: true };
    const now = isoMillis(this.now());
    if (input.outcome === "ok") {
      this.deps.store.transition(input.relatedDiscordMessageId, ["queued", "delivered", "failed"], "done", {
        resolvedAt: now,
        lastError: null,
        watchdogPosted: true,
      });
      this.audit({
        discordUserId: row.discordUserId,
        action: row.action,
        submissionId: row.submissionId,
        text: row.text,
        textSha256: row.textSha256,
        outcome: "done",
      });
    } else {
      const errorClass = input.outcome === "unknown" ? "state_unknown" : "mantis_failed";
      this.deps.store.transition(input.relatedDiscordMessageId, ["queued", "delivered", "failed"], "failed", {
        resolvedAt: now,
        lastError: errorClass,
        watchdogPosted: true,
      });
      this.audit({
        discordUserId: row.discordUserId,
        action: row.action,
        submissionId: row.submissionId,
        text: row.text,
        textSha256: row.textSha256,
        outcome: `failed:${errorClass}`,
      });
    }
    return { found: true, hashMismatch, alreadyResolved: false };
  }

  expireDue(): number {
    const now = isoMillis(this.now());
    const rows = this.deps.store.expirePreviews(now);
    for (const row of rows) {
      this.audit({
        discordUserId: row.discordUserId,
        action: row.action,
        submissionId: row.submissionId,
        text: row.text,
        textSha256: row.textSha256,
        outcome: "expired",
      });
    }
    return rows.length;
  }

  private rateLimit(userId: string): ActionFailure | null {
    const since = isoMillis(new Date(this.now().getTime() - RATE_WINDOW_MS));
    if (this.deps.store.countRecentActions(since, userId) >= USER_RATE_LIMIT) {
      return { ok: false, code: "rate_limited", error: "Rate limit: 10 actions per user per 10 minutes." };
    }
    if (this.deps.store.countRecentActions(since) >= GLOBAL_RATE_LIMIT) {
      return { ok: false, code: "rate_limited", error: "Rate limit: 30 actions per 10 minutes." };
    }
    return null;
  }

  private recheck(
    row: PendingAction,
    userId: string,
    channelId: string,
    options: { skipRateLimit?: boolean; skipInFlight?: boolean } = {},
  ): ActionFailure | null {
    if (!isAllowlisted(this.deps.allowlist, userId)) {
      return { ok: false, code: "not_allowlisted", error: "You are not on the Discord allowlist." };
    }
    const thread = this.deps.store.getThreadBySubmission(row.submissionId);
    if (!thread || thread.threadId !== channelId || thread.threadId !== row.threadId) {
      return { ok: false, code: "thread_mismatch", error: "This thread is no longer mapped to that submission." };
    }
    if (thread.blocked && row.action !== "open" && row.action !== "note") {
      return {
        ok: false,
        code: "blocked",
        error: "This submission is blocked. Only /open and /note are allowed until a human opens it.",
      };
    }
    if (!options.skipRateLimit) {
      const rate = this.rateLimit(row.discordUserId);
      if (rate) return rate;
    }
    if (!options.skipInFlight && this.deps.store.countInFlight(row.submissionId, row.discordMessageId) > 0) {
      return { ok: false, code: "in_flight", error: "Another action is already in flight for this submission." };
    }
    return null;
  }
}
