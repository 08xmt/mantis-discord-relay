import { webhookHost, type LogLevel } from "./logger";

export interface AppConfig {
  discordBotToken: string;
  discordGuildId: string;
  discordChannelId: string;
  discordAuditChannelId?: string;
  discordAdminChannelId?: string;
  allowlist: ReadonlySet<string>;
  actionWebhookUrl: string;
  actionHmacSecret: string;
  actionHmacSecretNext?: string;
  relayHmacSecret: string;
  relayHmacSecretNext?: string;
  relayHost: string;
  relayPort: number;
  databasePath: string;
  mantisAppUrl?: string;
  logLevel: LogLevel;
  heartbeatMs: number;
  deliveryTimeoutMs: number;
}

const SNOWFLAKE = /^\d{17,20}$/;
const PLACEHOLDER = /^replace-with/i;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function snowflake(name: string, value: string): string {
  if (!SNOWFLAKE.test(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return value;
}

function secretValue(name: string, value: string): string {
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters`);
  }
  if (PLACEHOLDER.test(value)) {
    throw new Error(`${name} is still a placeholder`);
  }
  return value;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === "") return "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new Error("LOG_LEVEL must be debug, info, warn, or error");
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8787;
  if (!/^\d+$/.test(value)) throw new Error("RELAY_PORT must be an integer");
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error("RELAY_PORT must be between 1 and 65535");
  return port;
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

export function parseAllowlist(raw: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!raw) return ids;
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "") continue;
    if (!SNOWFLAKE.test(id)) {
      throw new Error("ALLOWLIST_USER_IDS contains a value that is not a Discord snowflake");
    }
    ids.add(id);
  }
  return ids;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const discordBotToken = secretValue("DISCORD_BOT_TOKEN", required(env, "DISCORD_BOT_TOKEN"));
  const actionWebhookUrl = required(env, "ACTION_WEBHOOK_URL");
  let webhook: URL;
  try {
    webhook = new URL(actionWebhookUrl);
  } catch {
    throw new Error("ACTION_WEBHOOK_URL is not a valid URL");
  }
  if (webhook.protocol !== "https:" && webhook.protocol !== "http:") {
    throw new Error("ACTION_WEBHOOK_URL must be an http or https URL");
  }

  const mantisAppUrl = optional(env, "MANTIS_APP_URL");
  if (mantisAppUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(mantisAppUrl);
    } catch {
      throw new Error("MANTIS_APP_URL is not a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("MANTIS_APP_URL must be an http or https URL");
    }
  }

  const actionNext = optional(env, "ACTION_HMAC_SECRET_NEXT");
  const relayNext = optional(env, "RELAY_HMAC_SECRET_NEXT");

  return {
    discordBotToken,
    discordGuildId: snowflake("DISCORD_GUILD_ID", required(env, "DISCORD_GUILD_ID")),
    discordChannelId: snowflake("DISCORD_CHANNEL_ID", required(env, "DISCORD_CHANNEL_ID")),
    discordAuditChannelId: optional(env, "DISCORD_AUDIT_CHANNEL_ID")
      ? snowflake("DISCORD_AUDIT_CHANNEL_ID", optional(env, "DISCORD_AUDIT_CHANNEL_ID") as string)
      : undefined,
    discordAdminChannelId: optional(env, "DISCORD_ADMIN_CHANNEL_ID")
      ? snowflake("DISCORD_ADMIN_CHANNEL_ID", optional(env, "DISCORD_ADMIN_CHANNEL_ID") as string)
      : undefined,
    allowlist: parseAllowlist(optional(env, "ALLOWLIST_USER_IDS")),
    actionWebhookUrl,
    actionHmacSecret: secretValue("ACTION_HMAC_SECRET", required(env, "ACTION_HMAC_SECRET")),
    actionHmacSecretNext: actionNext
      ? secretValue("ACTION_HMAC_SECRET_NEXT", actionNext)
      : undefined,
    relayHmacSecret: secretValue("RELAY_HMAC_SECRET", required(env, "RELAY_HMAC_SECRET")),
    relayHmacSecretNext: relayNext ? secretValue("RELAY_HMAC_SECRET_NEXT", relayNext) : undefined,
    relayHost: optional(env, "RELAY_HOST") ?? "0.0.0.0",
    relayPort: parsePort(optional(env, "RELAY_PORT")),
    databasePath: optional(env, "DATABASE_PATH") ?? "./data/bot.sqlite",
    mantisAppUrl,
    logLevel: parseLogLevel(optional(env, "LOG_LEVEL")),
    heartbeatMs: parsePositiveInt("HEARTBEAT_INTERVAL_MS", optional(env, "HEARTBEAT_INTERVAL_MS"), 60 * 60 * 1000),
    deliveryTimeoutMs: parsePositiveInt("DELIVERY_TIMEOUT_MS", optional(env, "DELIVERY_TIMEOUT_MS"), 30_000),
  };
}

/** Safe to log. Contains no secrets and only the webhook host. */
export function startupLogLine(config: AppConfig): string {
  return [
    "config loaded",
    `webhook_host=${webhookHost(config.actionWebhookUrl)}`,
    `guild=${config.discordGuildId}`,
    `channel=${config.discordChannelId}`,
    `allowlist=${config.allowlist.size}`,
    `relay=${config.relayHost}:${config.relayPort}`,
    `action_next_secret=${config.actionHmacSecretNext ? "yes" : "no"}`,
    `relay_next_secret=${config.relayHmacSecretNext ? "yes" : "no"}`,
  ].join(" ");
}

export function configSecrets(config: AppConfig): string[] {
  return [
    config.discordBotToken,
    config.actionWebhookUrl,
    config.actionHmacSecret,
    config.actionHmacSecretNext ?? "",
    config.relayHmacSecret,
    config.relayHmacSecretNext ?? "",
  ].filter((value) => value.length >= 8);
}
