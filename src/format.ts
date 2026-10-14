import type { ActionName, StatusValue } from "./crypto";
import { sha256Hex } from "./crypto";
import {
  DISCORD_LIMIT,
  INBOUND_TRUNCATE_AT,
  fencedMessages,
  plainMessages,
  sanitizeUntrusted,
  truncateWithLink,
} from "./sanitize";
import type { MessageBody, SubmissionBody } from "./validate";

export interface OutboundMessage {
  content: string;
  allowedMentionUsers: string[];
  suppressEmbeds: true;
}

export function safeMessage(content: string, allowedMentionUsers: string[] = []): OutboundMessage {
  return { content, allowedMentionUsers, suppressEmbeds: true };
}

export function toOutbound(contents: string[], allowedMentionUsers: string[] = []): OutboundMessage[] {
  return contents.map((content, index) => safeMessage(content, index === 0 ? allowedMentionUsers : []));
}

export function threadName(submissionId: string, title: string, blocked: boolean): string {
  const prefix = blocked ? "⚠ " : "";
  const short = submissionId.slice(0, 8);
  const clean = sanitizeUntrusted(title).replace(/[\r\n]/g, " ").trim();
  return `${prefix}${short} ${clean}`.slice(0, 100);
}

export function mantisLink(baseUrl: string | undefined, submissionId: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/submissions/${encodeURIComponent(submissionId)}`;
}

function utcPlus8(iso: string): string {
  const date = new Date(iso);
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${formatted} UTC+8`;
}

export function formatSubmission(body: SubmissionBody, mantisAppUrl?: string): { name: string; chunks: OutboundMessage[] } {
  const link = mantisLink(mantisAppUrl, body.submission_id);
  const title = sanitizeUntrusted(body.title).replace(/[\r\n]/g, " ");
  const severity = sanitizeUntrusted(body.severity_claim).replace(/[\r\n]/g, " ");
  const name = threadName(body.submission_id, body.title, body.blocked);
  if (body.blocked) {
    const header = [
      "⚠️ **Flagged hunter** — submission body was not fetched.",
      `**Title:** ${title}`,
      `**Severity (hunter's claim):** ${severity}`,
      `**Status:** ${body.status}`,
      "",
      "A verified team flagged this hunter. Use `/open` after a human review to load the report.",
      "",
      `Mantis-ID: ${body.submission_id}`,
    ].join("\n");
    const record = body.hunter_record_md.trim();
    const chunks = record.length > 0
      ? fencedMessages(header, truncateWithLink(body.hunter_record_md, INBOUND_TRUNCATE_AT, link))
      : plainMessages(header);
    return { name, chunks: toOutbound(chunks) };
  }

  const header = [
    `**Submission** \`${body.submission_id}\``,
    `**Title:** ${title}`,
    `**Severity (hunter's claim):** ${severity}`,
    `**Status:** ${body.status}`,
    "",
    "**Summary**",
    `Mantis-ID: ${body.submission_id}`,
  ].join("\n");
  const summary = fencedMessages(header, truncateWithLink(body.summary_md, INBOUND_TRUNCATE_AT, link));
  const recordHeader = `**Hunter record**\nMantis-ID: ${body.submission_id}`;
  const record = fencedMessages(recordHeader, truncateWithLink(body.hunter_record_md, INBOUND_TRUNCATE_AT, link));
  return { name, chunks: toOutbound([...summary, ...record]) };
}

export function formatInboundMessage(message: MessageBody, mantisAppUrl: string | undefined, submissionId: string): OutboundMessage[] {
  const when = utcPlus8(message.created_at);
  const author = sanitizeUntrusted(message.author_label).replace(/[\r\n]/g, " ");
  const link = mantisLink(mantisAppUrl, submissionId);
  const body = truncateWithLink(message.body, INBOUND_TRUNCATE_AT, link);
  let header: string;
  if (message.kind === "hunter_msg") {
    header = `**Hunter ${author}** · ${when}`;
  } else if (message.kind === "followup") {
    header = `**Follow-up** · ${author} · ${when}`;
  } else if (message.kind === "status_change") {
    header = `**Status change** · ${author} · ${when}`;
  } else {
    header = `**Outcome** · ${author} · ${when}`;
  }
  if (message.kind === "outcome") {
    const cleaned = sanitizeUntrusted(body);
    return toOutbound(plainMessages(`${header}\n${cleaned}`));
  }
  return toOutbound(fencedMessages(header, body));
}

export function visibleToHunter(action: ActionName): boolean {
  return action === "reply" || action === "status";
}

export interface PreviewModel {
  submissionId: string;
  title: string;
  hunterLabel: string;
  action: ActionName;
  status?: StatusValue;
  text: string;
  textSha256: string;
  visibleToHunter: boolean;
}

export function shortId(submissionId: string): string {
  return submissionId.slice(0, 8);
}

export function renderPreview(model: PreviewModel): string[] {
  const lines = [
    `**Target:** \`${shortId(model.submissionId)}\` · ${sanitizeUntrusted(model.title).replace(/[\r\n]/g, " ")}`,
    `**Hunter:** ${sanitizeUntrusted(model.hunterLabel).replace(/[\r\n]/g, " ") || "unknown"}`,
    `**Action:** ${model.action}${model.status ? ` → \`${model.status}\`` : ""}`,
  ];
  if (model.visibleToHunter) {
    lines.push("🟥 **Visible to the hunter.**");
  }
  lines.push(`**sha256:** \`${model.textSha256}\``);
  lines.push("Exact text that will be sent:");
  lines.push("Preview expires in 5 minutes. After Send, confirmation usually takes under a minute.");
  const header = lines.join("\n");
  return fencedMessages(header, model.text.length > 0 ? model.text : "(empty)");
}

export function renderQueued(input: {
  userId: string;
  action: ActionName;
  status?: StatusValue;
  discordMessageId: string;
  text: string;
  textSha256: string;
}): string[] {
  const label = input.status ? `${input.action} ${input.status}` : input.action;
  const header = [
    `⏳ Queued by <@${input.userId}>: \`${label}\` (\`${input.discordMessageId}\`), confirming via Mantis, usually under a minute.`,
    `**sha256:** \`${input.textSha256}\``,
    "Verbatim text:",
  ].join("\n");
  return fencedMessages(header, input.text.length > 0 ? input.text : "(empty)");
}

export function renderWatchdog(discordMessageId: string): string {
  return [
    "⚠️ No confirmation yet. Check the Mantis thread before retrying.",
    `Action: \`${discordMessageId}\``,
  ].join("\n");
}

export function renderDeliveryFailure(errorClass: string, discordMessageId: string): string {
  return `❌ Failed: \`${sanitizeUntrusted(errorClass)}\`. No change made in Mantis. Action: \`${discordMessageId}\`. You can press Retry.`;
}

export function renderHashAlert(input: {
  submissionId: string;
  discordMessageId: string;
  stored: string;
  reported: string;
}): string {
  return `🚨 Hash mismatch for \`${input.submissionId}\` action \`${input.discordMessageId}\`. Stored \`${input.stored}\` reported \`${input.reported}\`.`;
}

export interface AuditView {
  discordUserId: string | null;
  action: string;
  submissionId: string | null;
  text: string | null;
  textSha256: string | null;
  outcome: string;
}

export function formatAuditMirror(entry: AuditView): string {
  const header = [
    `**Audit** ${entry.outcome}`,
    `action=${entry.action} user=${entry.discordUserId ?? "-"} submission=${entry.submissionId ?? "-"}`,
    entry.textSha256 ? `sha256=${entry.textSha256}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!entry.text) return plainMessages(header)[0] ?? header;
  return fencedMessages(header, entry.text)[0] ?? header;
}

export function hashText(text: string): string {
  return sha256Hex(text);
}

export function fitsDiscord(messages: readonly { content: string }[]): boolean {
  return messages.every((message) => message.content.length > 0 && message.content.length <= DISCORD_LIMIT);
}
