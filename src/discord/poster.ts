import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ForumChannel,
  type Message,
  type MessageCreateOptions,
  type NewsChannel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { OutboundMessage } from "../format";
import type { Logger } from "../logger";
import type { Notice, ThreadPoster } from "../poster";

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
  });
}

function payload(message: OutboundMessage, extra?: Pick<MessageCreateOptions, "components">): MessageCreateOptions {
  return {
    content: message.content,
    allowedMentions: {
      parse: [],
      users: message.allowedMentionUsers,
      roles: [],
      repliedUser: false,
    },
    flags: MessageFlags.SuppressEmbeds,
    components: extra?.components,
  };
}

function retryRow(discordMessageId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`retry:${discordMessageId}`).setLabel("Retry").setStyle(ButtonStyle.Secondary),
  );
}

export class DiscordJsPoster implements ThreadPoster {
  constructor(
    private readonly client: Client,
    private readonly parentChannelId: string,
    private readonly logger: Logger,
  ) {}

  async createSubmissionThread(input: {
    name: string;
    chunks: OutboundMessage[];
  }): Promise<{ threadId: string; starterMessageId: string }> {
    if (input.chunks.length === 0) throw new Error("empty_thread");
    const channel = await this.client.channels.fetch(this.parentChannelId);
    if (!channel) throw new Error("channel_missing");
    if (channel.type === ChannelType.GuildForum) {
      const forum = channel as ForumChannel;
      const thread = await forum.threads.create({
        name: input.name,
        message: payload(input.chunks[0]),
      });
      const starter = await thread.fetchStarterMessage();
      await this.sendAll(thread, input.chunks.slice(1));
      return { threadId: thread.id, starterMessageId: starter?.id ?? thread.id };
    }
    if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
      const parent = channel as TextChannel | NewsChannel;
      const starter = await parent.send(payload(input.chunks[0]));
      const thread = await starter.startThread({
        name: input.name,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      await this.sendAll(thread, input.chunks.slice(1));
      return { threadId: thread.id, starterMessageId: starter.id };
    }
    throw new Error("unsupported_channel");
  }

  async postToThread(threadId: string, chunks: OutboundMessage[]): Promise<{ messageId: string }> {
    return this.sendAll(await this.fetchThread(threadId), chunks);
  }

  async postToChannel(channelId: string, chunks: OutboundMessage[]): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error("channel_missing");
    return this.sendAll(channel, chunks);
  }

  async postNotice(threadId: string, content: string, notice: Notice): Promise<{ messageId: string }> {
    const channel = await this.fetchThread(threadId);
    try {
      const message = await channel.send(
        payload(
          { content, allowedMentionUsers: [], suppressEmbeds: true },
          { components: [retryRow(notice.discordMessageId)] },
        ),
      );
      return { messageId: message.id };
    } catch (error) {
      this.logger.error("discord send failed", { reason: error instanceof Error ? error.name : "unknown" });
      throw new Error("discord_post_failed");
    }
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) throw new Error("thread_missing");
    return channel;
  }

  private async sendAll(
    channel: { send: (options: MessageCreateOptions) => Promise<Message> },
    chunks: OutboundMessage[],
  ): Promise<{ messageId: string }> {
    let first = "";
    for (const chunk of chunks) {
      try {
        const message = await channel.send(payload(chunk));
        if (!first) first = message.id;
      } catch (error) {
        this.logger.error("discord send failed", { reason: error instanceof Error ? error.name : "unknown" });
        throw new Error("discord_post_failed");
      }
    }
    if (!first) throw new Error("empty_post");
    return { messageId: first };
  }
}
