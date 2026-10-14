import type { FastifyInstance } from "fastify";
import { ActionService } from "../src/actions";
import { hmacSha256Hex, relayStringToSign } from "../src/crypto";
import type { OutboundMessage } from "../src/format";
import { createLogger } from "../src/logger";
import type { ThreadPoster } from "../src/poster";
import { buildRelay, type AdminAlerter } from "../src/relay";
import { Store } from "../src/store";
import { payloadTimestamp, randomNonce } from "../src/time";

export const RELAY_SECRET = "relay-secret-0123456789abcdef0123456789";
export const RELAY_NEXT = "relay-next-secret-0123456789abcdef012345";
export const ACTION_SECRET = "action-secret-0123456789abcdef0123456789";
export const USER = "100000000000000021";
export const OTHER = "100000000000000022";
export const THREAD = "100000000000000031";
export const SUBMISSION = "sub_1";

export function snowflake(n: number): string {
  return `1${n.toString().padStart(17, "0")}`;
}

export function memoryStore(): Store {
  return new Store(":memory:");
}

export function seedThread(
  store: Store,
  overrides: Partial<{
    submissionId: string;
    threadId: string;
    title: string;
    blocked: boolean;
    hunterLabel: string | null;
  }> = {},
): void {
  store.insertThread({
    submissionId: overrides.submissionId ?? SUBMISSION,
    threadId: overrides.threadId ?? THREAD,
    starterMessageId: snowflake(41),
    title: overrides.title ?? "Report title",
    severityClaim: "high",
    status: "new",
    hunterLabel: overrides.hunterLabel === undefined ? "hunter-a" : overrides.hunterLabel,
    blocked: overrides.blocked ?? false,
    createdAt: "2026-10-14T07:00:00.000Z",
  });
}

export interface FakePoster extends ThreadPoster {
  threads: Array<{ name: string; chunks: OutboundMessage[]; threadId: string; starterMessageId: string }>;
  posts: Array<{ threadId: string; chunks: OutboundMessage[]; messageId: string }>;
  notices: Array<{ threadId: string; content: string; discordMessageId: string }>;
}

export function fakePoster(): FakePoster {
  const threads: FakePoster["threads"] = [];
  const posts: FakePoster["posts"] = [];
  const notices: FakePoster["notices"] = [];
  let n = 0;
  return {
    threads,
    posts,
    notices,
    async createSubmissionThread(input) {
      n += 1;
      const created = {
        ...input,
        threadId: snowflake(1000 + n),
        starterMessageId: snowflake(2000 + n),
      };
      threads.push(created);
      return { threadId: created.threadId, starterMessageId: created.starterMessageId };
    },
    async postToThread(threadId, chunks) {
      n += 1;
      const messageId = snowflake(3000 + n);
      posts.push({ threadId, chunks, messageId });
      return { messageId };
    },
    async postToChannel(channelId, chunks) {
      n += 1;
      const messageId = snowflake(4000 + n);
      posts.push({ threadId: channelId, chunks, messageId });
      return { messageId };
    },
    async postNotice(threadId, content, notice) {
      n += 1;
      notices.push({ threadId, content, discordMessageId: notice.discordMessageId });
      return { messageId: snowflake(5000 + n) };
    },
  };
}

export function signedHeaders(raw: string, secret = RELAY_SECRET, now = new Date("2026-10-14T07:42:00.000Z")): Record<string, string> {
  const timestamp = payloadTimestamp(now);
  const nonce = randomNonce();
  const signature = hmacSha256Hex(secret, relayStringToSign(timestamp, nonce, raw));
  return {
    "content-type": "application/json",
    "x-relay-timestamp": timestamp,
    "x-relay-nonce": nonce,
    "x-relay-signature": signature,
  };
}

export function fixedNonceHeaders(raw: string, nonce: string, secret = RELAY_SECRET, timestamp = "2026-10-14T07:42:00Z"): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-relay-timestamp": timestamp,
    "x-relay-nonce": nonce,
    "x-relay-signature": hmacSha256Hex(secret, relayStringToSign(timestamp, nonce, raw)),
  };
}

export function testRelay(options: {
  store?: Store;
  poster?: FakePoster;
  secrets?: string[];
  alerts?: string[];
  now?: () => Date;
} = {}): { app: FastifyInstance; store: Store; poster: FakePoster; actions: ActionService } {
  const store = options.store ?? memoryStore();
  const poster = options.poster ?? fakePoster();
  const now = options.now ?? (() => new Date("2026-10-14T07:42:00.000Z"));
  const actions = new ActionService({
    store,
    allowlist: new Set([USER, OTHER]),
    now,
  });
  const alerter: AdminAlerter = {
    admin: (message) => {
      options.alerts?.push(message);
    },
  };
  const app = buildRelay({
    secrets: options.secrets ?? [RELAY_SECRET, RELAY_NEXT],
    store,
    poster,
    actions,
    logger: createLogger({ write: () => undefined }),
    mantisAppUrl: "https://mantis.example.invalid",
    alerter,
    now,
  });
  return { app, store, poster, actions };
}

export function submissionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submission_id: SUBMISSION,
    title: "Stored XSS in bounty form",
    severity_claim: "high",
    status: "new",
    summary_md: "The hunter says hello.",
    hunter_record_md: "Verified team. No flags.",
    blocked: false,
    hunter_label: "hunter-a",
    ...overrides,
  };
}
