import type { OutboundMessage } from "./format";

export interface Notice {
  kind: "retry";
  discordMessageId: string;
}

export interface ThreadPoster {
  createSubmissionThread(input: {
    name: string;
    chunks: OutboundMessage[];
  }): Promise<{ threadId: string; starterMessageId: string }>;
  postToThread(threadId: string, chunks: OutboundMessage[]): Promise<{ messageId: string }>;
  postToChannel(channelId: string, chunks: OutboundMessage[]): Promise<{ messageId: string }>;
  postNotice(threadId: string, content: string, notice: Notice): Promise<{ messageId: string }>;
}
