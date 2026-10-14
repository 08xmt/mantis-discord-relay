export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

const TOKEN_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g;

export function redactText(input: string, secrets: readonly string[]): string {
  let out = input;
  const sorted = secrets
    .filter((secret) => typeof secret === "string" && secret.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out.replace(TOKEN_RE, "[REDACTED_TOKEN]");
}

export function createLogger(options: {
  level?: LogLevel;
  secrets?: readonly string[];
  write?: (line: string) => void;
}): Logger {
  const level = options.level ?? "info";
  const secrets = options.secrets ?? [];
  const write = options.write ?? ((line: string) => console.log(line));

  const emit = (entryLevel: LogLevel, message: string, extra?: Record<string, unknown>) => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;
    const payload =
      extra && Object.keys(extra).length > 0 ? `${message} ${JSON.stringify(extra)}` : message;
    const line = redactText(`${new Date().toISOString()} ${entryLevel} ${payload}`, secrets);
    write(line);
  };

  return {
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
  };
}

export function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "[invalid-url]";
  }
}
