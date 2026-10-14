import { describe, expect, it } from "vitest";
import { ActionService } from "../src/actions";
import { verifyActionEnvelope } from "../src/crypto";
import { Deliverer } from "../src/deliver";
import { createLogger } from "../src/logger";
import { DELIVERY_BACKOFF_MS } from "../src/time";
import { ACTION_SECRET, THREAD, USER, memoryStore, seedThread, snowflake } from "./helpers";

const NOW = new Date("2026-10-14T07:42:00.000Z");

function queuedAction(text = "hello @everyone") {
  const store = memoryStore();
  seedThread(store);
  const actions = new ActionService({ store, allowlist: new Set([USER]), now: () => NOW });
  const prepared = actions.prepare({ threadId: THREAD, userId: USER, action: "reply", text });
  if (!prepared.ok) throw new Error(prepared.error);
  const messageId = snowflake(108);
  actions.commitPreview(messageId, prepared, USER);
  const sent = actions.confirmSend(messageId, USER, THREAD);
  if (!sent.ok) throw new Error(sent.error);
  return { store, actions, action: sent.action };
}

describe("delivery", () => {
  it("retries with a fresh nonce and the same discord message id", async () => {
    const { actions, action, store } = queuedAction();
    const bodies: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const deliverer = new Deliverer({
      webhookUrl: "https://hooks.example/secret-path",
      secret: ACTION_SECRET,
      actions,
      logger: createLogger({ write: () => undefined }),
      timeoutMs: 30_000,
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      post: async (_url, body) => {
        bodies.push(body);
        calls += 1;
        if (calls < 3) return { status: 503 };
        return { status: 204 };
      },
    });
    const result = await deliverer.deliver(action);
    expect(result).toBe("delivered");
    expect(sleeps).toEqual([DELIVERY_BACKOFF_MS[0], DELIVERY_BACKOFF_MS[1]]);
    expect(store.getAction(action.discordMessageId)?.attempts).toBe(3);
    expect(store.getAction(action.discordMessageId)?.state).toBe("delivered");
    const seen = new Set<string>();
    const ids = bodies.map((body) => {
      const envelope = JSON.parse(body) as { payload: string; sig: string };
      const verified = verifyActionEnvelope(envelope, [ACTION_SECRET], { now: NOW, nonceSeen: (nonce) => seen.has(nonce) });
      expect(verified.ok).toBe(true);
      if (!verified.ok) throw new Error("signature");
      seen.add(verified.payload.nonce);
      expect(verified.payload.text).toContain("@everyone");
      return verified.payload.discord_message_id;
    });
    expect(new Set(ids)).toEqual(new Set([action.discordMessageId]));
    expect(seen.size).toBe(3);
  });

  it("stops after a timeout and exposes Retry state", async () => {
    const { actions, action, store } = queuedAction("hello");
    const exhausted: string[] = [];
    const deliverer = new Deliverer({
      webhookUrl: "https://hooks.example/secret-path",
      secret: ACTION_SECRET,
      actions,
      logger: createLogger({ write: () => undefined }),
      timeoutMs: 30_000,
      now: () => NOW,
      sleep: async () => undefined,
      post: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      onExhausted: (_action, errorClass) => {
        exhausted.push(errorClass);
      },
    });
    const result = await deliverer.deliver(action);
    expect(result).toBe("failed");
    expect(exhausted).toEqual(["timeout"]);
    expect(store.getAction(action.discordMessageId)?.state).toBe("failed");
    expect(store.getAction(action.discordMessageId)?.attempts).toBe(4);
    const retry = actions.beginRetry(action.discordMessageId, USER, THREAD);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.action.discordMessageId).toBe(action.discordMessageId);
  });

  it("abort during an in-flight post does not mark the action failed", async () => {
    const { actions, action, store } = queuedAction("hello");
    let release: (value: { status: number }) => void = () => undefined;
    const deliverer = new Deliverer({
      webhookUrl: "https://hooks.example/secret-path",
      secret: ACTION_SECRET,
      actions,
      logger: createLogger({ write: () => undefined }),
      timeoutMs: 30_000,
      now: () => NOW,
      sleep: async () => undefined,
      post: (_url, _body, _timeout, signal) =>
        new Promise((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    });
    const pending = deliverer.deliver(action);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await deliverer.abortAndWait(action.discordMessageId);
    expect(await pending).toBe("aborted");
    expect(store.getAction(action.discordMessageId)?.state).toBe("queued");
    release({ status: 200 });
  });
});
