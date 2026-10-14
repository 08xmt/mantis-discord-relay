import { describe, expect, it } from "vitest";
import { ActionService } from "../src/actions";
import { buildSignedPost } from "../src/deliver";
import { renderQueued } from "../src/format";
import { OTHER, SUBMISSION, THREAD, USER, memoryStore, seedThread, snowflake } from "./helpers";

function service(allowlist = new Set([USER, OTHER])) {
  const store = memoryStore();
  seedThread(store);
  const audits: string[] = [];
  const actions = new ActionService({
    store,
    allowlist,
    now: () => new Date("2026-10-14T07:42:00.000Z"),
    onAudit: (entry) => audits.push(entry.outcome),
  });
  return { store, actions, audits };
}

describe("actions", () => {
  it("rejects a user who is not allowlisted", () => {
    const { actions } = service(new Set([OTHER]));
    const result = actions.prepare({ threadId: THREAD, userId: USER, action: "reply", text: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_allowlisted");
  });

  it("rejects a command outside a mapped thread", () => {
    const { actions } = service();
    const result = actions.prepare({ threadId: snowflake(99), userId: USER, action: "note", text: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_thread");
  });

  it("blocks hunter-visible commands on a flagged submission and allows note and open", () => {
    const { store, actions } = service();
    seedThread(store, { submissionId: "blocked_1", threadId: snowflake(77), blocked: true });
    const reply = actions.prepare({ threadId: snowflake(77), userId: USER, action: "reply", text: "hello" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.code).toBe("blocked");
    const note = actions.prepare({ threadId: snowflake(77), userId: USER, action: "note", text: "internal" });
    expect(note.ok).toBe(true);
    const open = actions.prepare({ threadId: snowflake(77), userId: USER, action: "open", text: "" });
    expect(open.ok).toBe(true);
    const ordinary = actions.prepare({ threadId: THREAD, userId: USER, action: "open", text: "" });
    expect(ordinary.ok).toBe(false);
    if (!ordinary.ok) expect(ordinary.code).toBe("not_blocked");
  });

  it("enforces body and status-note length", () => {
    const { actions } = service();
    const note = actions.prepare({ threadId: THREAD, userId: USER, action: "status", text: "n".repeat(4001), status: "accepted" });
    expect(note.ok).toBe(false);
    if (!note.ok) expect(note.code).toBe("too_long");
    const body = actions.prepare({ threadId: THREAD, userId: USER, action: "reply", text: "x".repeat(16_001) });
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.code).toBe("too_long");
    const ok = actions.prepare({ threadId: THREAD, userId: USER, action: "status", text: "n".repeat(4000), status: "paid" });
    expect(ok.ok).toBe(true);
  });

  it("sends once, ignores a double click, and cancels before send", () => {
    const { actions, audits, store } = service();
    const prepared = actions.prepare({ threadId: THREAD, userId: USER, action: "reply", text: "hello @everyone" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const messageId = snowflake(101);
    expect(actions.commitPreview(messageId, prepared, USER).ok).toBe(true);
    const audit = store.listAudit();
    expect(audit[0]?.text).toContain("@everyone");
    const first = actions.confirmSend(messageId, USER, THREAD);
    const second = actions.confirmSend(messageId, USER, THREAD);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_handled");
    expect(audits).toContain("queued");
    const row = store.getAction(messageId);
    expect(row?.state).toBe("queued");
    expect(row?.text).toBe("hello @everyone");

    const other = actions.prepare({ threadId: THREAD, userId: OTHER, action: "note", text: "private" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("in_flight");

    const cancelPrepared = actions.prepare({ threadId: THREAD, userId: USER, action: "note", text: "later" });
    // Still in flight from the queued reply, so a new preview is refused.
    expect(cancelPrepared.ok).toBe(false);
  });

  it("cancel and expiry do not queue an action", () => {
    const { actions, store } = service();
    const prepared = actions.prepare({ threadId: THREAD, userId: USER, action: "note", text: "private" });
    if (!prepared.ok) throw new Error("expected preview");
    const messageId = snowflake(102);
    actions.commitPreview(messageId, prepared, USER);
    expect(actions.cancel(messageId, OTHER).ok).toBe(false);
    expect(actions.cancel(messageId, USER).ok).toBe(true);
    expect(actions.confirmSend(messageId, USER, THREAD).ok).toBe(false);
    expect(store.getAction(messageId)?.state).toBe("cancelled");

    const again = actions.prepare({ threadId: THREAD, userId: USER, action: "note", text: "private" });
    if (!again.ok) throw new Error("expected preview");
    const expiredId = snowflake(103);
    actions.commitPreview(expiredId, { ...again, expiresAt: "2020-01-01T00:00:00.000Z" }, USER);
    const expired = actions.confirmSend(expiredId, USER, THREAD);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("expired");
    expect(store.getAction(expiredId)?.state).toBe("expired");
  });

  it("rechecks the allowlist at send time", () => {
    const allowlist = new Set([USER]);
    const { actions } = service(allowlist);
    const prepared = actions.prepare({ threadId: THREAD, userId: USER, action: "reply", text: "hello" });
    if (!prepared.ok) throw new Error("expected preview");
    const messageId = snowflake(104);
    actions.commitPreview(messageId, prepared, USER);
    allowlist.delete(USER);
    const sent = actions.confirmSend(messageId, USER, THREAD);
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.code).toBe("not_allowlisted");
  });

  it("rate limits a user after 10 confirmed actions", () => {
    const { store, actions } = service();
    for (let index = 0; index < 10; index += 1) {
      const prepared = actions.prepare({ threadId: THREAD, userId: USER, action: "note", text: `n${index}` });
      if (!prepared.ok) throw new Error(prepared.error);
      const messageId = snowflake(500 + index);
      actions.commitPreview(messageId, prepared, USER);
      expect(actions.confirmSend(messageId, USER, THREAD).ok).toBe(true);
      actions.recordOutcome({ relatedDiscordMessageId: messageId, outcome: "ok", bodySha256: prepared.textSha256 });
    }
    const blocked = actions.prepare({ threadId: THREAD, userId: USER, action: "note", text: "one more" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("10 actions");
    const other = actions.prepare({ threadId: THREAD, userId: OTHER, action: "note", text: "still ok" });
    expect(other.ok).toBe(true);
    expect(store.countRecentActions("2026-10-14T07:32:00.000Z", USER)).toBe(10);
  });

  it("stores the original text for delivery and sanitizes only the Discord rendering", () => {
    const { actions } = service();
    const prepared = actions.prepare({
      threadId: THREAD,
      userId: USER,
      action: "reply",
      text: "hello @everyone https://evil.example/x",
    });
    if (!prepared.ok) throw new Error("expected preview");
    const messageId = snowflake(106);
    actions.commitPreview(messageId, prepared, USER);
    const sent = actions.confirmSend(messageId, USER, THREAD);
    if (!sent.ok) throw new Error(sent.error);
    const signed = buildSignedPost(sent.action, "action-secret-0123456789abcdef0123456789", new Date("2026-10-14T07:42:00.000Z"), "00112233445566778899aabbccddeeff");
    expect(signed.payload.text).toContain("@everyone");
    expect(signed.payload.text).toContain("https://evil.example/x");
    expect(signed.payload.discord_message_id).toBe(messageId);
    const rendered = renderQueued({
      userId: USER,
      action: "reply",
      discordMessageId: messageId,
      text: sent.action.text,
      textSha256: sent.action.textSha256,
    }).join("\n");
    expect(rendered).not.toMatch(/@(everyone|here)/i);
    expect(rendered).toContain("<https://evil.example/x>");
  });

  it("flags a reported body hash that does not match and retries the same id", () => {
    const { actions, store, audits } = service();
    const prepared = actions.prepare({ threadId: THREAD, userId: USER, action: "status", text: "paying", status: "paid" });
    if (!prepared.ok) throw new Error("expected preview");
    const messageId = snowflake(107);
    actions.commitPreview(messageId, prepared, USER);
    const sent = actions.confirmSend(messageId, USER, THREAD);
    if (!sent.ok) throw new Error(sent.error);
    const mismatch = actions.recordOutcome({
      relatedDiscordMessageId: messageId,
      outcome: "ok",
      bodySha256: "ab".repeat(32),
    });
    expect(mismatch.hashMismatch).toBe(true);
    expect(store.getAction(messageId)?.state).toBe("done");
    expect(audits.some((outcome) => outcome.startsWith("hash_mismatch:"))).toBe(true);
    const retry = actions.beginRetry(messageId, OTHER, THREAD);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.code).toBe("already_handled");
  });

  it("rate limits the server after 30 confirmed actions", () => {
    const { store, actions } = service();
    for (let index = 0; index < 30; index += 1) {
      const messageId = snowflake(800 + index);
      store.insertPreview({
        discordMessageId: messageId,
        submissionId: SUBMISSION,
        discordUserId: snowflake(9000 + index),
        action: "note",
        statusValue: null,
        text: "x",
        textSha256: "ab".repeat(32),
        createdAt: "2026-10-14T07:42:00.000Z",
        expiresAt: "2026-10-14T07:47:00.000Z",
      });
      store.transition(messageId, ["preview"], "queued", { queuedAt: "2026-10-14T07:42:00.000Z" });
      store.transition(messageId, ["queued"], "done", { resolvedAt: "2026-10-14T07:42:00.000Z" });
    }
    const blocked = actions.prepare({ threadId: THREAD, userId: USER, action: "note", text: "too many" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("30 actions");
  });

  it("retry after failure keeps the preview message id", () => {
    const { actions, store } = service();
    const prepared = actions.prepare({ threadId: THREAD, userId: USER, action: "reply", text: "hello" });
    if (!prepared.ok) throw new Error("expected preview");
    const messageId = snowflake(108);
    actions.commitPreview(messageId, prepared, USER);
    actions.confirmSend(messageId, USER, THREAD);
    actions.markDeliveryFailed(messageId, "timeout");
    expect(store.getAction(messageId)?.state).toBe("failed");
    const retry = actions.beginRetry(messageId, USER, THREAD);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.action.discordMessageId).toBe(messageId);
      expect(retry.action.submissionId).toBe(SUBMISSION);
      expect(retry.action.state).toBe("queued");
    }
  });
});
