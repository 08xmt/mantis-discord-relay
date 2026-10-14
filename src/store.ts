import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { ActionName, StatusValue } from "./crypto";
import { isoMillis, NONCE_TTL_MS } from "./time";

export type ActionState =
  | "preview"
  | "queued"
  | "delivered"
  | "done"
  | "failed"
  | "expired"
  | "cancelled";

export interface ThreadRow {
  submissionId: string;
  threadId: string;
  starterMessageId: string;
  title: string;
  severityClaim: string | null;
  status: string | null;
  hunterLabel: string | null;
  blocked: boolean;
  createdAt: string;
}

export interface PostedSource {
  sourceId: string;
  submissionId: string;
  discordMessageId: string;
  kind: string;
  createdAt: string;
}

export interface PendingAction {
  discordMessageId: string;
  submissionId: string;
  threadId: string;
  discordUserId: string;
  action: ActionName;
  statusValue: StatusValue | null;
  text: string;
  textSha256: string;
  state: ActionState;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  queuedAt: string | null;
  resolvedAt: string | null;
  expiresAt: string;
  watchdogPosted: boolean;
  title: string;
  blocked: boolean;
  hunterLabel: string | null;
}

export interface AuditRecord {
  id?: number;
  ts: string;
  discordUserId: string | null;
  action: string;
  submissionId: string | null;
  text: string | null;
  textSha256: string | null;
  outcome: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_map (
  submission_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE,
  starter_message_id TEXT NOT NULL,
  title TEXT NOT NULL,
  severity_claim TEXT,
  status TEXT,
  hunter_label TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posted_sources (
  source_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  discord_message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES thread_map(submission_id)
);

CREATE TABLE IF NOT EXISTS pending_actions (
  discord_message_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('reply','note','status','open')),
  status_value TEXT CHECK(status_value IS NULL OR status_value IN ('new','acknowledged','accepted','rejected','duplicate','paid','closed')),
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preview','queued','delivered','done','failed','expired','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  queued_at TEXT,
  resolved_at TEXT,
  expires_at TEXT NOT NULL,
  watchdog_posted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (submission_id) REFERENCES thread_map(submission_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  discord_user_id TEXT,
  action TEXT NOT NULL,
  submission_id TEXT,
  text TEXT,
  text_sha256 TEXT,
  outcome TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_submission_state ON pending_actions(submission_id, state);
CREATE INDEX IF NOT EXISTS idx_pending_watchdog ON pending_actions(state, queued_at, watchdog_posted);
CREATE INDEX IF NOT EXISTS idx_nonces_seen ON relay_nonces(seen_at);
`;

interface ThreadSql {
  submission_id: string;
  thread_id: string;
  starter_message_id: string;
  title: string;
  severity_claim: string | null;
  status: string | null;
  hunter_label: string | null;
  blocked: number;
  created_at: string;
}

interface PendingSql {
  discord_message_id: string;
  submission_id: string;
  thread_id: string;
  discord_user_id: string;
  action: ActionName;
  status_value: StatusValue | null;
  text: string;
  text_sha256: string;
  state: ActionState;
  attempts: number;
  last_error: string | null;
  created_at: string;
  queued_at: string | null;
  resolved_at: string | null;
  expires_at: string;
  watchdog_posted: number;
  title: string;
  blocked: number;
  hunter_label: string | null;
}

function mapThread(row: ThreadSql): ThreadRow {
  return {
    submissionId: row.submission_id,
    threadId: row.thread_id,
    starterMessageId: row.starter_message_id,
    title: row.title,
    severityClaim: row.severity_claim,
    status: row.status,
    hunterLabel: row.hunter_label,
    blocked: row.blocked === 1,
    createdAt: row.created_at,
  };
}

function mapPending(row: PendingSql): PendingAction {
  return {
    discordMessageId: row.discord_message_id,
    submissionId: row.submission_id,
    threadId: row.thread_id,
    discordUserId: row.discord_user_id,
    action: row.action,
    statusValue: row.status_value,
    text: row.text,
    textSha256: row.text_sha256,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
    watchdogPosted: row.watchdog_posted === 1,
    title: row.title,
    blocked: row.blocked === 1,
    hunterLabel: row.hunter_label,
  };
}

const PENDING_SELECT = `
SELECT p.discord_message_id, p.submission_id, t.thread_id, p.discord_user_id, p.action,
       p.status_value, p.text, p.text_sha256, p.state, p.attempts, p.last_error,
       p.created_at, p.queued_at, p.resolved_at, p.expires_at, p.watchdog_posted,
       t.title, t.blocked, t.hunter_label
FROM pending_actions p
JOIN thread_map t ON t.submission_id = p.submission_id
`;

export class Store {
  readonly db: Database.Database;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    const version = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
    if (!version) {
      this.db
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
        .run(isoMillis(new Date()));
    }
  }

  close(): void {
    this.db.close();
  }

  getThreadBySubmission(submissionId: string): ThreadRow | undefined {
    const row = this.db.prepare("SELECT * FROM thread_map WHERE submission_id = ?").get(submissionId) as
      | ThreadSql
      | undefined;
    return row ? mapThread(row) : undefined;
  }

  getThreadByThreadId(threadId: string): ThreadRow | undefined {
    const row = this.db.prepare("SELECT * FROM thread_map WHERE thread_id = ?").get(threadId) as
      | ThreadSql
      | undefined;
    return row ? mapThread(row) : undefined;
  }

  insertThread(row: {
    submissionId: string;
    threadId: string;
    starterMessageId: string;
    title: string;
    severityClaim: string;
    status: string;
    hunterLabel: string | null;
    blocked: boolean;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO thread_map
         (submission_id, thread_id, starter_message_id, title, severity_claim, status, hunter_label, blocked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.submissionId,
        row.threadId,
        row.starterMessageId,
        row.title,
        row.severityClaim,
        row.status,
        row.hunterLabel,
        row.blocked ? 1 : 0,
        row.createdAt,
      );
  }

  getPostedSource(sourceId: string): PostedSource | undefined {
    const row = this.db.prepare("SELECT * FROM posted_sources WHERE source_id = ?").get(sourceId) as
      | {
          source_id: string;
          submission_id: string;
          discord_message_id: string;
          kind: string;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      sourceId: row.source_id,
      submissionId: row.submission_id,
      discordMessageId: row.discord_message_id,
      kind: row.kind,
      createdAt: row.created_at,
    };
  }

  insertPostedSource(row: {
    sourceId: string;
    submissionId: string;
    discordMessageId: string;
    kind: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO posted_sources (source_id, submission_id, discord_message_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.sourceId, row.submissionId, row.discordMessageId, row.kind, row.createdAt);
  }

  insertPreview(row: {
    discordMessageId: string;
    submissionId: string;
    discordUserId: string;
    action: ActionName;
    statusValue: StatusValue | null;
    text: string;
    textSha256: string;
    createdAt: string;
    expiresAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_actions
         (discord_message_id, submission_id, discord_user_id, action, status_value, text, text_sha256,
          state, attempts, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'preview', 0, ?, ?)`,
      )
      .run(
        row.discordMessageId,
        row.submissionId,
        row.discordUserId,
        row.action,
        row.statusValue,
        row.text,
        row.textSha256,
        row.createdAt,
        row.expiresAt,
      );
  }

  getAction(discordMessageId: string): PendingAction | undefined {
    const row = this.db.prepare(`${PENDING_SELECT} WHERE p.discord_message_id = ?`).get(discordMessageId) as
      | PendingSql
      | undefined;
    return row ? mapPending(row) : undefined;
  }

  countRecentActions(sinceIso: string, userId?: string): number {
    if (userId) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM pending_actions
           WHERE discord_user_id = ?
             AND state IN ('queued','delivered','done','failed')
             AND queued_at >= ?`,
        )
        .get(userId, sinceIso) as { n: number };
      return row.n;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM pending_actions
         WHERE state IN ('queued','delivered','done','failed')
           AND queued_at >= ?`,
      )
      .get(sinceIso) as { n: number };
    return row.n;
  }

  countInFlight(submissionId: string, exceptMessageId?: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM pending_actions
         WHERE submission_id = ?
           AND state IN ('queued','delivered')
           AND discord_message_id != ?`,
      )
      .get(submissionId, exceptMessageId ?? "") as { n: number };
    return row.n;
  }

  transition(discordMessageId: string, from: ActionState[], to: ActionState, fields: {
    queuedAt?: string | null;
    resolvedAt?: string | null;
    lastError?: string | null;
    watchdogPosted?: boolean;
  }): boolean {
    const assignments = ["state = ?"];
    const params: Array<string | number | null> = [to];
    if (fields.queuedAt !== undefined) {
      assignments.push("queued_at = ?");
      params.push(fields.queuedAt);
    }
    if (fields.resolvedAt !== undefined) {
      assignments.push("resolved_at = ?");
      params.push(fields.resolvedAt);
    }
    if (fields.lastError !== undefined) {
      assignments.push("last_error = ?");
      params.push(fields.lastError);
    }
    if (fields.watchdogPosted !== undefined) {
      assignments.push("watchdog_posted = ?");
      params.push(fields.watchdogPosted ? 1 : 0);
    }
    const placeholders = from.map(() => "?").join(", ");
    params.push(discordMessageId, ...from);
    const result = this.db
      .prepare(
        `UPDATE pending_actions SET ${assignments.join(", ")}
         WHERE discord_message_id = ? AND state IN (${placeholders})`,
      )
      .run(...params);
    return result.changes === 1;
  }

  noteAttempt(discordMessageId: string, lastError: string | null): void {
    this.db
      .prepare(
        `UPDATE pending_actions
         SET attempts = attempts + 1, last_error = ?
         WHERE discord_message_id = ? AND state IN ('queued','delivered')`,
      )
      .run(lastError, discordMessageId);
  }

  setLastError(discordMessageId: string, lastError: string): void {
    this.db
      .prepare(
        `UPDATE pending_actions SET last_error = ?
         WHERE discord_message_id = ? AND state IN ('queued','delivered')`,
      )
      .run(lastError, discordMessageId);
  }

  markWatchdogPosted(discordMessageId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE pending_actions SET watchdog_posted = 1
         WHERE discord_message_id = ? AND watchdog_posted = 0`,
      )
      .run(discordMessageId);
    return result.changes === 1;
  }

  listWatchdogDue(queuedBeforeIso: string): PendingAction[] {
    const rows = this.db
      .prepare(
        `${PENDING_SELECT}
         WHERE p.state IN ('queued','delivered')
           AND p.watchdog_posted = 0
           AND p.queued_at IS NOT NULL
           AND p.queued_at <= ?`,
      )
      .all(queuedBeforeIso) as PendingSql[];
    return rows.map(mapPending);
  }

  listRecoverable(): PendingAction[] {
    const rows = this.db
      .prepare(`${PENDING_SELECT} WHERE p.state = 'queued'`)
      .all() as PendingSql[];
    return rows.map(mapPending);
  }

  expirePreviews(nowIso: string): PendingAction[] {
    const rows = this.db
      .prepare(`${PENDING_SELECT} WHERE p.state = 'preview' AND p.expires_at <= ?`)
      .all(nowIso) as PendingSql[];
    if (rows.length === 0) return [];
    this.db
      .prepare(
        `UPDATE pending_actions
         SET state = 'expired', resolved_at = ?
         WHERE state = 'preview' AND expires_at <= ?`,
      )
      .run(nowIso, nowIso);
    return rows.map(mapPending);
  }

  appendAudit(record: AuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, discord_user_id, action, submission_id, text, text_sha256, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.ts,
        record.discordUserId,
        record.action,
        record.submissionId,
        record.text,
        record.textSha256,
        record.outcome,
      );
  }

  listAudit(): AuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, discord_user_id, action, submission_id, text, text_sha256, outcome
         FROM audit_log ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      ts: string;
      discord_user_id: string | null;
      action: string;
      submission_id: string | null;
      text: string | null;
      text_sha256: string | null;
      outcome: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      discordUserId: row.discord_user_id,
      action: row.action,
      submissionId: row.submission_id,
      text: row.text,
      textSha256: row.text_sha256,
      outcome: row.outcome,
    }));
  }

  /**
   * Returns false when the nonce was already stored. The insert is the replay check.
   */
  rememberNonce(nonce: string, now: Date): boolean {
    const cutoff = isoMillis(new Date(now.getTime() - NONCE_TTL_MS));
    const insert = this.db.transaction(() => {
      this.db.prepare("DELETE FROM relay_nonces WHERE seen_at < ?").run(cutoff);
      const result = this.db
        .prepare("INSERT INTO relay_nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .run(nonce, isoMillis(now));
      return result.changes === 1;
    });
    return insert();
  }

  countThreads(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM thread_map").get() as { n: number };
    return row.n;
  }

  countPending(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE state IN ('queued','delivered')")
      .get() as { n: number };
    return row.n;
  }
}

export function openStore(filename: string): Store {
  return new Store(filename);
}
