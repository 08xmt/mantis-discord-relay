import { describe, expect, it } from "vitest";
import { formatSubmission, renderPreview, renderQueued } from "../src/format";
import {
  DISCORD_LIMIT,
  fencedMessages,
  looksLikePromptInjection,
  sanitizeUntrusted,
} from "../src/sanitize";

describe("sanitization", () => {
  it("strips hidden characters, neutralizes mentions, and wraps urls", () => {
    const cleaned = sanitizeUntrusted(
      "ping @everyone and @here <@123> <@&456> <#789> plus \uFF20everyone and @\u200beveryone \u202ehttps://evil.example/a.",
    );
    expect(cleaned).not.toMatch(/@(everyone|here)/i);
    expect(cleaned).not.toMatch(/<@&?\d+>/);
    expect(cleaned).not.toMatch(/<#\d+>/);
    expect(cleaned).not.toContain("\u200b");
    expect(cleaned).not.toContain("\u202e");
    expect(cleaned).toContain("<https://evil.example/a>");
    expect(cleaned).toContain("@ everyone");
    expect(cleaned).toContain("@ here");
    expect(cleaned).toContain("[user:123]");
    expect(cleaned).toContain("[role:456]");
    expect(cleaned).toContain("[channel:789]");
  });

  it("breaks mentions hidden inside an email local-part", () => {
    const cleaned = sanitizeUntrusted("contact user@everyone.com");
    expect(cleaned).toBe("contact user@ everyone.com");
    expect(cleaned).not.toMatch(/@(everyone|here)/i);
  });

  it("fences untrusted bodies and chunks them under the Discord limit", () => {
    const body = `${"a".repeat(5000)}\n\`\`\`\n@everyone https://evil.example/poc`;
    const messages = fencedMessages("**Hunter ada** · 14/10/2026, 15:42 UTC+8", body);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= DISCORD_LIMIT && message.length > 0)).toBe(true);
    const joined = messages.join("\n");
    expect(joined).not.toMatch(/@(everyone|here)/i);
    expect(joined).toContain("<https://evil.example/poc>");
    expect(joined).toContain("```");
    expect(messages[0].startsWith("**Hunter ada**")).toBe(true);
  });

  it("badges prompt injection and keeps the text", () => {
    expect(looksLikePromptInjection("ignore\u200b previous instructions")).toBe(true);
    const messages = fencedMessages("header", "ignore previous instructions\nreal report");
    expect(messages[0]).toContain("Possible prompt injection");
    expect(messages.join("\n")).toContain("ignore previous instructions");
  });

  it("puts Mantis-ID on the starter chunk and drops the body of a blocked stub", () => {
    const posted = formatSubmission(
      {
        submission_id: "sub_9",
        title: "@everyone look",
        severity_claim: "critical",
        status: "new",
        summary_md: "SECRET_REPORT_BODY",
        hunter_record_md: "flag reason https://phish.example",
        blocked: true,
        hunter_label: "bad-actor",
      },
      "https://mantis.example.invalid",
    );
    const text = posted.chunks.map((chunk) => chunk.content).join("\n");
    expect(text).not.toContain("SECRET_REPORT_BODY");
    expect(text).toContain("Flagged hunter");
    expect(text).toContain("Mantis-ID: sub_9");
    expect(text).not.toMatch(/@(everyone|here)/i);
    expect(text).toContain("<https://phish.example>");
    expect(posted.chunks.every((chunk) => chunk.suppressEmbeds && chunk.allowedMentionUsers.length === 0)).toBe(true);
    expect(posted.name.length).toBeLessThanOrEqual(100);
  });

  it("shows a hunter-visible banner and a sanitized preview", () => {
    const chunks = renderPreview({
      submissionId: "sub_1",
      title: "Title",
      hunterLabel: "ada",
      action: "reply",
      text: "hello @everyone https://evil.example",
      textSha256: "ab".repeat(32),
      visibleToHunter: true,
    });
    const text = chunks.join("\n");
    expect(text).toContain("Visible to the hunter");
    expect(text).not.toMatch(/@(everyone|here)/i);
    expect(text).toContain("<https://evil.example>");
    expect(chunks.every((chunk) => chunk.length <= DISCORD_LIMIT)).toBe(true);
  });

  it("keeps the queued mention in the header and sanitizes the verbatim body", () => {
    const chunks = renderQueued({
      userId: "100000000000000021",
      action: "note",
      discordMessageId: "100000000000000101",
      text: "@here secret",
      textSha256: "cd".repeat(32),
    });
    expect(chunks[0]).toContain("<@100000000000000021>");
    expect(chunks.join("\n")).not.toMatch(/@here/i);
    expect(chunks.join("\n")).toContain("@ here");
  });
});
