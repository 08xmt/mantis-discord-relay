import { describe, expect, it } from "vitest";
import { configSecrets, loadConfig, startupLogLine, type AppConfig } from "../src/config";
import { createLogger, redactText } from "../src/logger";

const TOKEN = `M${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`;
const WEBHOOK = "https://hooks.example/very-secret-path-0123456789abcdef";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_GUILD_ID: "100000000000000001",
    DISCORD_CHANNEL_ID: "100000000000000002",
    DISCORD_AUDIT_CHANNEL_ID: "100000000000000003",
    DISCORD_ADMIN_CHANNEL_ID: "100000000000000004",
    ALLOWLIST_USER_IDS: "100000000000000021",
    ACTION_WEBHOOK_URL: WEBHOOK,
    ACTION_HMAC_SECRET: "a".repeat(32),
    RELAY_HMAC_SECRET: "b".repeat(32),
    ...overrides,
  };
}

describe("secret redaction", () => {
  it("startup logs the webhook host only", () => {
    const config = loadConfig(env());
    const line = startupLogLine(config);
    expect(line).toContain("webhook_host=hooks.example");
    expect(line).not.toContain("very-secret-path");
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("a".repeat(32));
    const logs: string[] = [];
    const logger = createLogger({ secrets: configSecrets(config), write: (entry) => logs.push(entry) });
    logger.info(`posting ${config.actionWebhookUrl} token ${config.discordBotToken} secret ${config.actionHmacSecret}`);
    const text = logs.join("\n");
    expect(text).not.toContain("very-secret-path");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("a".repeat(32));
    expect(text).toContain("[REDACTED]");
  });

  it("redacts token-shaped strings even when they are not in the secret list", () => {
    expect(redactText(`leaked ${TOKEN}`, [])).toContain("[REDACTED_TOKEN]");
    expect(redactText(`leaked ${TOKEN}`, [])).not.toContain(TOKEN);
  });

  it("config errors name the variable and omit the secret value", () => {
    expect(() => loadConfig(env({ DISCORD_GUILD_ID: "nope" }))).toThrowError(/^DISCORD_GUILD_ID must be a Discord snowflake$/);
    expect(() => loadConfig(env({ ACTION_HMAC_SECRET: "replace-with-openssl-rand-hex-32" }))).toThrowError(
      /^ACTION_HMAC_SECRET is still a placeholder$/,
    );
    try {
      loadConfig(env({ RELAY_HMAC_SECRET: "" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toBe("Missing required environment variable RELAY_HMAC_SECRET");
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain("very-secret-path");
    }
  });

  it("does not accept a short hmac secret", () => {
    expect(() => loadConfig(env({ RELAY_HMAC_SECRET: "short-secret" }))).toThrowError(/at least 32 characters/);
    const config: AppConfig = loadConfig(env({ ACTION_HMAC_SECRET_NEXT: "c".repeat(32) }));
    expect(config.actionHmacSecretNext).toBe("c".repeat(32));
  });
});
