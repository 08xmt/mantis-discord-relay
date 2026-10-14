import { canonicalActionPayload, hmacSha256Hex, type ActionPayload } from "./crypto";
import type { ActionService } from "./actions";
import type { Logger } from "./logger";
import type { PendingAction } from "./store";
import { DELIVERY_ATTEMPTS, DELIVERY_BACKOFF_MS, payloadTimestamp, randomNonce } from "./time";

export interface DeliveryDeps {
  webhookUrl: string;
  secret: string;
  actions: ActionService;
  logger: Logger;
  timeoutMs: number;
  post?: (url: string, body: string, timeoutMs: number, signal: AbortSignal) => Promise<{ status: number }>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  onDelivered?: (action: PendingAction) => Promise<void> | void;
  onExhausted?: (action: PendingAction, errorClass: string) => Promise<void> | void;
}

export interface SignedPost {
  body: string;
  payload: ActionPayload;
  payloadString: string;
}

export function buildSignedPost(action: PendingAction, secret: string, now: Date, nonce = randomNonce()): SignedPost {
  const payload: ActionPayload = {
    v: 1,
    submission_id: action.submissionId,
    action: action.action,
    text: action.text,
    discord_user_id: action.discordUserId,
    discord_message_id: action.discordMessageId,
    discord_thread_id: action.threadId,
    timestamp: payloadTimestamp(now),
    nonce,
  };
  if (action.action === "status" && action.statusValue) payload.status = action.statusValue;
  const payloadString = canonicalActionPayload({
    submission_id: payload.submission_id,
    action: payload.action,
    text: payload.text,
    status: payload.status,
    discord_user_id: payload.discord_user_id,
    discord_message_id: payload.discord_message_id,
    discord_thread_id: payload.discord_thread_id,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
  });
  const sig = hmacSha256Hex(secret, payloadString);
  return { body: JSON.stringify({ payload: payloadString, sig }), payload, payloadString };
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function defaultPost(url: string, body: string, timeoutMs: number, signal: AbortSignal): Promise<{ status: number }> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: timeout.signal,
      redirect: "error",
    });
    return { status: response.status };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export class Deliverer {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(private readonly deps: DeliveryDeps) {}

  inProgress(messageId: string): boolean {
    return this.active.has(messageId);
  }

  async abortAndWait(messageId: string): Promise<void> {
    const run = this.active.get(messageId);
    if (!run) return;
    run.abort.abort();
    await run.done;
  }

  deliver(action: PendingAction): Promise<"delivered" | "failed" | "aborted" | "skipped"> {
    if (this.active.has(action.discordMessageId)) return Promise.resolve("skipped");
    const abort = new AbortController();
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active.set(action.discordMessageId, { abort, done });
    const run = this.run(action, abort.signal).finally(() => {
      if (this.active.get(action.discordMessageId)?.abort === abort) {
        this.active.delete(action.discordMessageId);
      }
      resolveDone();
    });
    return run;
  }

  private async run(action: PendingAction, signal: AbortSignal): Promise<"delivered" | "failed" | "aborted"> {
    const post = this.deps.post ?? defaultPost;
    const sleep = this.deps.sleep ?? defaultSleep;
    const now = this.deps.now ?? (() => new Date());
    let lastError = "unknown";
    for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt += 1) {
      if (signal.aborted) return "aborted";
      const signed = buildSignedPost(action, this.deps.secret, now(), randomNonce());
      this.deps.actions.noteAttempt(action.discordMessageId, null);
      try {
        const response = await post(this.deps.webhookUrl, signed.body, this.deps.timeoutMs, signal);
        if (response.status >= 200 && response.status < 300) {
          this.deps.actions.markDelivered(action.discordMessageId);
          await this.deps.onDelivered?.(action);
          return "delivered";
        }
        lastError = `http_${response.status}`;
        this.deps.logger.warn("action webhook rejected", {
          submission_id: action.submissionId,
          discord_message_id: action.discordMessageId,
          attempt,
          status: response.status,
        });
      } catch (error) {
        if (signal.aborted) return "aborted";
        lastError = isTimeoutError(error) ? "timeout" : "network";
        this.deps.logger.warn("action webhook attempt failed", {
          submission_id: action.submissionId,
          discord_message_id: action.discordMessageId,
          attempt,
          error: lastError,
        });
      }
      this.deps.actions.setLastError(action.discordMessageId, lastError);
      if (attempt < DELIVERY_ATTEMPTS) {
        try {
          await sleep(DELIVERY_BACKOFF_MS[attempt - 1], signal);
        } catch {
          return "aborted";
        }
      }
    }
    if (signal.aborted) return "aborted";
    this.deps.actions.markDeliveryFailed(action.discordMessageId, lastError);
    await this.deps.onExhausted?.(action, lastError);
    return "failed";
  }
}
