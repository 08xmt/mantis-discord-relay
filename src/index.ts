import { ActionService } from "./actions";
import { configSecrets, loadConfig, startupLogLine } from "./config";
import { registerCommands, registerInteractions, startWatchdog, type BotDeps } from "./discord/bot";
import { createDiscordClient, DiscordJsPoster } from "./discord/poster";
import { Deliverer } from "./deliver";
import { formatAuditMirror, renderDeliveryFailure, safeMessage } from "./format";
import { createLogger } from "./logger";
import { buildRelay } from "./relay";
import { openStore } from "./store";

function safeStartupError(error: unknown): string {
  if (!(error instanceof Error)) return "startup failed";
  if (
    error.message.startsWith("Missing required") ||
    error.message.includes("must be") ||
    error.message.includes("placeholder") ||
    error.message.includes("not a valid") ||
    error.message.includes("LOG_LEVEL")
  ) {
    return error.message;
  }
  return `startup failed (${error.name})`;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.logLevel, secrets: configSecrets(config) });
  logger.info(startupLogLine(config));
  if (config.allowlist.size === 0) {
    logger.warn("allowlist is empty; slash commands will be rejected");
  }

  const store = openStore(config.databasePath);
  const client = createDiscordClient();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    client.once("clientReady", finish);
    client.once("ready", finish);
    client.login(config.discordBotToken).catch(fail);
  });

  const poster = new DiscordJsPoster(client, config.discordChannelId, logger);
  const actions = new ActionService({
    store,
    allowlist: config.allowlist,
    onAudit: (entry) => {
      if (!config.discordAuditChannelId) return;
      const content = formatAuditMirror(entry);
      void poster.postToChannel(config.discordAuditChannelId, [safeMessage(content)]).catch(() => {
        logger.error("audit mirror failed");
      });
    },
  });
  const deliverer = new Deliverer({
    webhookUrl: config.actionWebhookUrl,
    secret: config.actionHmacSecret,
    actions,
    logger,
    timeoutMs: config.deliveryTimeoutMs,
    onExhausted: async (action, errorClass) => {
      await poster.postNotice(action.threadId, renderDeliveryFailure(errorClass, action.discordMessageId), {
        kind: "retry",
        discordMessageId: action.discordMessageId,
      });
    },
  });
  const deps: BotDeps = {
    client,
    guildId: config.discordGuildId,
    actions,
    deliverer,
    poster,
    store,
    logger,
  };
  registerInteractions(deps);
  await registerCommands(client, config.discordGuildId, config.discordBotToken, logger);

  const relaySecrets = [config.relayHmacSecret, config.relayHmacSecretNext ?? ""].filter((secret) => secret.length > 0);
  const relay = buildRelay({
    secrets: relaySecrets,
    store,
    poster,
    actions,
    logger,
    mantisAppUrl: config.mantisAppUrl,
    alerter: {
      admin: async (message) => {
        logger.error(message);
        if (!config.discordAdminChannelId) return;
        await poster.postToChannel(config.discordAdminChannelId, [safeMessage(message)]);
      },
    },
  });
  await relay.listen({ host: config.relayHost, port: config.relayPort });
  logger.info("relay listening", { port: config.relayPort });

  const stopWatchdog = startWatchdog(deps);
  const heartbeat = setInterval(() => {
    const line = `heartbeat ok threads=${store.countThreads()} inflight=${store.countPending()}`;
    logger.info(line);
    if (!config.discordAdminChannelId) return;
    void poster.postToChannel(config.discordAdminChannelId, [safeMessage(line)]).catch(() => {
      logger.error("heartbeat post failed");
    });
  }, config.heartbeatMs);

  const recoverable = store.listRecoverable();
  for (const action of recoverable) {
    void deliverer.deliver(action);
  }
  logger.info("resumed queued actions", { count: recoverable.length });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopWatchdog();
    clearInterval(heartbeat);
    await relay.close();
    client.destroy();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(safeStartupError(error));
  process.exit(1);
});
