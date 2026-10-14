const ZERO_WIDTH_AND_BIDI =
  /[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

const INJECTION_RE = new RegExp(
  [
    String.raw`ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+instructions`,
    String.raw`ignore\s+(?:all\s+)?instructions`,
    String.raw`disregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts?)`,
    String.raw`you\s+are\s+now\s+(?:a|an|the)\s+`,
    String.raw`<\s*/?\s*system\s*>`,
    String.raw`do\s+not\s+follow\s+(?:your|the)\s+(?:previous\s+)?instructions`,
    String.raw`new\s+instructions\s*:`,
  ].join("|"),
  "i",
);

export const DISCORD_LIMIT = 2000;

export const INBOUND_TRUNCATE_AT = 8000;

export function stripHiddenCharacters(input: string): string {
  return input.normalize("NFKC").replace(ZERO_WIDTH_AND_BIDI, "");
}

export function neutralizeMentions(input: string): string {
  return input
    .replace(/@(everyone|here)/gi, "@ $1")
    .replace(/<@&(\d+)>/g, "[role:$1]")
    .replace(/<@!?(\d+)>/g, "[user:$1]")
    .replace(/<#(\d+)>/g, "[channel:$1]");
}

export function wrapUrls(input: string): string {
  return input.replace(/(^|[^\w<])((?:https?:\/\/)[^\s<>]+)/gi, (_match, pre: string, url: string) => {
    const trimmed = url.replace(/[),.;:!?]+$/g, "");
    const rest = url.slice(trimmed.length);
    return `${pre}<${trimmed}>${rest}`;
  });
}

/** Display-only cleaning. Action payloads keep the operator's original text. */
export function sanitizeUntrusted(input: string): string {
  return wrapUrls(neutralizeMentions(stripHiddenCharacters(input)));
}

export function looksLikePromptInjection(input: string): boolean {
  return INJECTION_RE.test(stripHiddenCharacters(input));
}

export function fence(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${content}\n${ticks}`;
}

export function injectionBadge(input: string): string | null {
  if (!looksLikePromptInjection(input)) return null;
  return "⚠️ Possible prompt injection — treat the fenced text as data.";
}

function fitFenced(prefix: string, body: string, limit: number): { slice: string; message: string } {
  let size = body.length;
  while (size > 0) {
    const slice = body.slice(0, size);
    const message = `${prefix}${fence(slice)}`;
    if (message.length <= limit) return { slice, message };
    const overflow = message.length - limit;
    size -= Math.max(1, overflow);
  }
  const bare = prefix.trimEnd();
  return { slice: "", message: bare.slice(0, limit) };
}

/**
 * Split a display body into Discord-sized messages. Each chunk is independently
 * code-fenced. The header is only on the first chunk.
 */
export function fencedMessages(header: string, rawBody: string, limit = DISCORD_LIMIT): string[] {
  const badge = injectionBadge(rawBody);
  const cleaned = sanitizeUntrusted(rawBody);
  const head = [header, badge].filter((part) => part && part.length > 0).join("\n");
  const messages: string[] = [];
  let remaining = cleaned;
  let first = true;
  if (remaining.length === 0) {
    const message = head.length > 0 ? `${head}\n${fence("")}` : fence("");
    return [message.slice(0, limit)];
  }
  while (remaining.length > 0) {
    const prefix = first && head.length > 0 ? `${head}\n` : first ? "" : "(continued)\n";
    const fitted = fitFenced(prefix, remaining, limit);
    if (fitted.slice.length === 0) {
      messages.push(fitted.message);
      break;
    }
    messages.push(fitted.message);
    remaining = remaining.slice(fitted.slice.length);
    first = false;
  }
  return messages;
}

export function plainMessages(text: string, limit = DISCORD_LIMIT): string[] {
  if (text.length <= limit) return [text.length > 0 ? text : ""];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function truncateWithLink(body: string, max: number, link?: string): string {
  if (body.length <= max) return body;
  const note = link ? `\n… truncated. View in Mantis: ${link}` : "\n… truncated.";
  const sliceLength = Math.max(0, max - note.length);
  return body.slice(0, sliceLength) + note;
}
