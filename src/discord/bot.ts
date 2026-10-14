import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ActionService, PreparedPreview } from "../actions";
import { STATUS_VALUES, type ActionName, type StatusValue } from "../crypto";
import type { Deliverer } from "../deliver";
import { renderDeliveryFailure, renderPreview, renderQueued, renderWatchdog, safeMessage } from "../format";
import type { Logger } from "../logger";
import type { ThreadPoster } from "../poster";
import type { Store } from "../store";
import { WATCHDOG_MS, isoMillis } from "../time";
import { buildCommands } from "./commands";

type PreviewInteraction = ChatInputCommandInteraction | ModalSubmitInteraction;

export interface BotDeps {
  client: Client;
  guildId: string;
  actions: ActionService;
  deliverer: Deliverer;
  poster: ThreadPoster;
  store: Store;
  logger: Logger;
}

export async function registerCommands(client: Client, guildId: string, token: string, logger: Logger): Promise<void> {
  if (!client.user) throw new Error("discord_not_ready");
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
    body: buildCommands().map((command) => command.toJSON()),
  });
  logger.info("registered guild slash commands", { count: 4 });
}

export function registerInteractions(deps: BotDeps): void {
  deps.client.on("interactionCreate", (interaction) => {
    void handleInteraction(deps, interaction).catch((error) => {
      deps.logger.error("interaction failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    });
  });
}

async function handleInteraction(deps: BotDeps, interaction: unknown): Promise<void> {
  const candidate = interaction as { isChatInputCommand?: () => boolean; isButton?: () => boolean; isModalSubmit?: () => boolean };
  if (candidate.isChatInputCommand?.()) {
    await onCommand(deps, interaction as ChatInputCommandInteraction);
    return;
  }
  if (candidate.isButton?.()) {
    await onButton(deps, interaction as ButtonInteraction);
    return;
  }
  if (candidate.isModalSubmit?.()) {
    await onModal(deps, interaction as ModalSubmitInteraction);
  }
}

async function onCommand(deps: BotDeps, interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.commandName;
  if (name !== "reply" && name !== "note" && name !== "status" && name !== "open") return;
  if (!interaction.channelId) {
    await interaction.reply({ content: "Use this command inside a submission thread.", flags: MessageFlags.Ephemeral });
    return;
  }
  if ((name === "reply" || name === "note") && !interaction.options.getString("text")?.trim()) {
    await interaction.showModal(textModal(name));
    return;
  }
  const text = name === "status" ? (interaction.options.getString("note") ?? "") : name === "open" ? "" : (interaction.options.getString("text") ?? "");
  const status = name === "status" ? parseStatus(interaction.options.getString("value", true)) : undefined;
  if (name === "status" && !status) {
    await interaction.reply({ content: "Status must be one of the allowed values.", flags: MessageFlags.Ephemeral });
    return;
  }
  const prepared = deps.actions.prepare({
    threadId: interaction.channelId,
    userId: interaction.user.id,
    action: name,
    text,
    status,
  });
  if (!prepared.ok) {
    await interaction.reply({ content: prepared.error, flags: MessageFlags.Ephemeral });
    return;
  }
  await showPreview(deps, interaction, prepared);
}

async function onModal(deps: BotDeps, interaction: ModalSubmitInteraction): Promise<void> {
  const action: ActionName | undefined =
    interaction.customId === "modal:reply" ? "reply" : interaction.customId === "modal:note" ? "note" : undefined;
  if (!action || !interaction.channelId) return;
  const text = interaction.fields.getTextInputValue("text");
  const prepared = deps.actions.prepare({
    threadId: interaction.channelId,
    userId: interaction.user.id,
    action,
    text,
  });
  if (!prepared.ok) {
    await interaction.reply({ content: prepared.error, flags: MessageFlags.Ephemeral });
    return;
  }
  await showPreview(deps, interaction, prepared);
}

async function showPreview(deps: BotDeps, interaction: PreviewInteraction, prepared: PreparedPreview): Promise<void> {
  const chunks = renderPreview({
    submissionId: prepared.submissionId,
    title: prepared.title,
    hunterLabel: prepared.hunterLabel,
    action: prepared.action,
    status: prepared.status,
    text: prepared.text,
    textSha256: prepared.textSha256,
    visibleToHunter: prepared.visibleToHunter,
  });
  await interaction.reply({
    content: chunks[0],
    components: [previewRow(prepared.visibleToHunter)],
    flags: MessageFlags.Ephemeral,
  });
  const reply = await interaction.fetchReply();
  for (const extra of chunks.slice(1)) {
    await interaction.followUp({ content: extra, flags: MessageFlags.Ephemeral });
  }
  const committed = deps.actions.commitPreview(reply.id, prepared, interaction.user.id);
  if (!committed.ok) {
    await interaction.editReply({ content: committed.error, components: [] });
  }
}

async function onButton(deps: BotDeps, interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId === "send" || interaction.customId === "cancel") {
    await interaction.deferUpdate();
    if (!interaction.channelId) return;
    if (interaction.customId === "cancel") {
      const result = deps.actions.cancel(interaction.message.id, interaction.user.id);
      if (!result.ok) {
        await interaction.followUp({ content: result.error, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.editReply({ content: "Cancelled. Nothing was sent.", components: [] });
      return;
    }
    const result = deps.actions.confirmSend(interaction.message.id, interaction.user.id, interaction.channelId);
    if (!result.ok) {
      await interaction.followUp({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.editReply({
      content: "Queued. Confirmation usually takes under a minute.",
      components: [],
    });
    const chunks = renderQueued({
      userId: result.action.discordUserId,
      action: result.action.action,
      status: result.action.statusValue ?? undefined,
      discordMessageId: result.action.discordMessageId,
      text: result.action.text,
      textSha256: result.action.textSha256,
    });
    await deps.poster.postToThread(
      result.action.threadId,
      chunks.map((content, index) => safeMessage(content, index === 0 ? [result.action.discordUserId] : [])),
    );
    void deps.deliverer.deliver(result.action).catch(() => {
      deps.logger.error("delivery failed", { discord_message_id: result.action.discordMessageId });
    });
    return;
  }
  if (interaction.customId.startsWith("retry:")) {
    const messageId = interaction.customId.slice("retry:".length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.channelId) {
      await interaction.editReply("Use Retry inside the submission thread.");
      return;
    }
    await deps.deliverer.abortAndWait(messageId);
    const result = deps.actions.beginRetry(messageId, interaction.user.id, interaction.channelId);
    if (!result.ok) {
      await interaction.editReply(result.error);
      return;
    }
    await interaction.editReply("Retrying with the same action id. Confirmation usually takes under a minute.");
    void deps.deliverer.deliver(result.action).catch(() => {
      deps.logger.error("retry delivery failed", { discord_message_id: messageId });
    });
  }
}

function previewRow(visibleToHunter: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("send")
      .setLabel("Send")
      .setStyle(visibleToHunter ? ButtonStyle.Danger : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

function textModal(action: "reply" | "note"): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId("text")
    .setLabel(action === "reply" ? "Reply the hunter will see" : "Private note")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);
  return new ModalBuilder()
    .setCustomId(`modal:${action}`)
    .setTitle(action === "reply" ? "Reply to hunter" : "Private note")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function parseStatus(value: string): StatusValue | undefined {
  return STATUS_VALUES.find((status) => status === value);
}

export function startWatchdog(deps: BotDeps, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        deps.actions.expireDue();
        const cutoff = isoMillis(new Date(Date.now() - WATCHDOG_MS));
        const due = deps.store.listWatchdogDue(cutoff);
        for (const action of due) {
          await deps.poster.postNotice(action.threadId, renderWatchdog(action.discordMessageId), {
            kind: "retry",
            discordMessageId: action.discordMessageId,
          });
          deps.store.markWatchdogPosted(action.discordMessageId);
        }
      } catch {
        deps.logger.error("watchdog tick failed");
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}

export function deliveryFailureText(errorClass: string, discordMessageId: string): string {
  return renderDeliveryFailure(errorClass, discordMessageId);
}
