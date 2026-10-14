import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { ActionService } from "./actions";
import { BurstAlert } from "./burst";
import { relayStringToSign, verifyHmac } from "./crypto";
import { formatInboundMessage, formatSubmission, renderHashAlert, type OutboundMessage } from "./format";
import type { Logger } from "./logger";
import type { ThreadPoster } from "./poster";
import { serialize } from "./serialize";
import type { Store } from "./store";
import { SKEW_MS, isoMillis, withinSkew } from "./time";
import { validateMessage, validateSubmission } from "./validate";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface AdminAlerter {
  admin(message: string): Promise<void> | void;
}

export interface RelayOptions {
  secrets: readonly string[];
  store: Store;
  poster: ThreadPoster;
  actions: ActionService;
  logger: Logger;
  mantisAppUrl?: string;
  alerter?: AdminAlerter;
  now?: () => Date;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export function buildRelay(options: RelayOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const now = options.now ?? (() => new Date());
  const burst = new BurstAlert(5, 10 * 60 * 1000, (count) => {
    const message = `bad_signature burst: ${count} rejected relay requests in 10 minutes`;
    options.logger.error(message);
    void options.alerter?.admin(message);
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    (request as FastifyRequest).rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch {
      const error = new Error("invalid") as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 400) {
      void reply.code(400).send({ error: "invalid" });
      return;
    }
    options.logger.error("relay request failed");
    void reply.code(500).send({ error: "unavailable" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  function authorize(request: FastifyRequest): { ok: true } | { ok: false; error: string } {
    const timestamp = headerValue(request.headers["x-relay-timestamp"]);
    const nonce = headerValue(request.headers["x-relay-nonce"]);
    const signature = headerValue(request.headers["x-relay-signature"]);
    if (!timestamp || !nonce || !signature || !/^[0-9a-f]{32}$/.test(nonce)) {
      return { ok: false, error: "bad_signature" };
    }
    const current = now();
    if (!withinSkew(timestamp, current, SKEW_MS)) {
      return { ok: false, error: "stale_timestamp" };
    }
    const raw = request.rawBody ?? "";
    if (!verifyHmac(options.secrets, relayStringToSign(timestamp, nonce, raw), signature)) {
      burst.hit(current.getTime());
      return { ok: false, error: "bad_signature" };
    }
    if (!options.store.rememberNonce(nonce, current)) {
      return { ok: false, error: "replay" };
    }
    return { ok: true };
  }

  app.post("/v1/submissions", async (request, reply) => {
    const auth = authorize(request);
    if (!auth.ok) return reply.code(401).send({ error: auth.error });
    const parsed = validateSubmission(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid" });
    const body = parsed.body;
    try {
      const result = await serialize(`submission:${body.submission_id}`, async () => {
        const existing = options.store.getThreadBySubmission(body.submission_id);
        if (existing) return { thread_id: existing.threadId, duplicate: true };
        const formatted = formatSubmission(body, options.mantisAppUrl);
        assertSafe(formatted.chunks);
        const created = await options.poster.createSubmissionThread({
          name: formatted.name,
          chunks: formatted.chunks,
        });
        options.store.insertThread({
          submissionId: body.submission_id,
          threadId: created.threadId,
          starterMessageId: created.starterMessageId,
          title: body.title,
          severityClaim: body.severity_claim,
          status: body.status,
          hunterLabel: body.hunter_label ?? null,
          blocked: body.blocked,
          createdAt: isoMillis(now()),
        });
        return { thread_id: created.threadId, duplicate: false };
      });
      return reply.code(200).send(result);
    } catch {
      options.logger.error("submission relay failed", { submission_id: body.submission_id });
      return reply.code(500).send({ error: "unavailable" });
    }
  });

  app.post<{ Params: { id: string } }>("/v1/submissions/:id/messages", async (request, reply) => {
    const auth = authorize(request);
    if (!auth.ok) return reply.code(401).send({ error: auth.error });
    const submissionId = request.params.id;
    if (submissionId.length < 1 || submissionId.length > 128 || /[\s\u0000-\u001f\u007f]/.test(submissionId)) {
      return reply.code(400).send({ error: "invalid" });
    }
    const parsed = validateMessage(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid" });
    const message = parsed.body;
    try {
      const result = await serialize(`source:${message.source_id}`, async () => {
        const existing = options.store.getPostedSource(message.source_id);
        if (existing) {
          if (existing.submissionId !== submissionId) {
            return { status: 409, body: { error: "source_conflict" } };
          }
          return {
            status: 200,
            body: { discord_message_id: existing.discordMessageId, duplicate: true, hash_mismatch: false },
          };
        }
        const thread = options.store.getThreadBySubmission(submissionId);
        if (!thread) return { status: 404, body: { error: "unknown_submission" } };
        const chunks = formatInboundMessage(message, options.mantisAppUrl, submissionId);
        assertSafe(chunks);
        const posted = await options.poster.postToThread(thread.threadId, chunks);
        options.store.insertPostedSource({
          sourceId: message.source_id,
          submissionId,
          discordMessageId: posted.messageId,
          kind: message.kind,
          createdAt: isoMillis(now()),
        });
        let hashMismatch = false;
        if (message.related_discord_message_id) {
          const outcome = options.actions.recordOutcome({
            relatedDiscordMessageId: message.related_discord_message_id,
            bodySha256: message.body_sha256,
            outcome: message.outcome,
          });
          hashMismatch = outcome.hashMismatch;
          if (hashMismatch) {
            const action = options.store.getAction(message.related_discord_message_id);
            const alert = renderHashAlert({
              submissionId,
              discordMessageId: message.related_discord_message_id,
              stored: action?.textSha256 ?? "missing",
              reported: message.body_sha256 ?? "missing",
            });
            options.logger.error(alert);
            await options.alerter?.admin(alert);
          }
        }
        return {
          status: 200,
          body: { discord_message_id: posted.messageId, duplicate: false, hash_mismatch: hashMismatch },
        };
      });
      return reply.code(result.status).send(result.body);
    } catch {
      options.logger.error("message relay failed", { submission_id: submissionId });
      return reply.code(500).send({ error: "unavailable" });
    }
  });

  return app;
}

function assertSafe(chunks: OutboundMessage[]): void {
  for (const chunk of chunks) {
    if (!chunk.suppressEmbeds) throw new Error("suppress_embeds_required");
    if (chunk.allowedMentionUsers.length > 0) throw new Error("mentions_forbidden");
    if (chunk.content.length === 0 || chunk.content.length > 2000) throw new Error("discord_length");
    if (/@(everyone|here)/i.test(chunk.content)) throw new Error("mention_not_neutralized");
    if (/<@&?\d+>/.test(chunk.content) || /<#\d+>/.test(chunk.content)) throw new Error("mention_not_neutralized");
  }
}
