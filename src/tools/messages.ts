import { z } from "zod";
import type { FacebookClient } from "../facebook/client.js";

const messageSchema = z
  .string()
  .trim()
  .min(1)
  .max(10_000)
  .describe("Plain-text message to send");

export const checkMessagesSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum recent inbox threads to return (default: 20)"),
};

export const readMessageThreadSchema = {
  thread_id: z.string().min(1).describe("Facebook Messenger thread ID"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum recent messages to return (default: 20)"),
};

export const startSellerThreadSchema = {
  seller_id: z.string().min(1).describe("Facebook ID of the Marketplace seller"),
  message: messageSchema,
};

export const sendThreadMessageSchema = {
  thread_id: z.string().min(1).describe("Existing Facebook Messenger thread ID"),
  message: messageSchema,
};

function formatTimestamp(value: string): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return value || "unknown time";
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp).toISOString();
}

export function createCheckMessagesHandler(client: FacebookClient) {
  return async (args: { limit: number }) => {
    try {
      const threads = await client.checkMessages(args.limit);
      if (threads.length === 0) {
        return { content: [{ type: "text" as const, text: "No message threads found in the inbox." }] };
      }
      const text = threads
        .map((thread, index) => {
          const unread = thread.unreadCount > 0 ? ` | **${thread.unreadCount} unread**` : "";
          const people = thread.participantNames.length > 0 ? ` | ${thread.participantNames.join(", ")}` : "";
          return `${index + 1}. **${thread.title || "Untitled thread"}**${unread}${people}\n   Thread ID: \`${thread.id}\` | ${formatTimestamp(thread.updatedAt)}\n   ${thread.snippet || "(no text preview)"}`;
        })
        .join("\n\n");
      return { content: [{ type: "text" as const, text: `Recent message threads:\n\n${text}` }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error checking messages: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  };
}

export function createReadMessageThreadHandler(client: FacebookClient) {
  return async (args: { thread_id: string; limit: number }) => {
    try {
      const messages = await client.getMessageThread(args.thread_id, args.limit);
      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: "No text messages found in this thread." }] };
      }
      const text = messages
        .map((message) => `**${message.senderId || "Unknown sender"}** — ${formatTimestamp(message.sentAt)}\n${message.text}`)
        .join("\n\n");
      return { content: [{ type: "text" as const, text: `Thread \`${args.thread_id}\`:\n\n${text}` }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error reading message thread: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  };
}

export function createStartSellerThreadHandler(client: FacebookClient) {
  return async (args: { seller_id: string; message: string }) => {
    try {
      const result = await client.sendSellerMessage({ sellerId: args.seller_id, message: args.message });
      return {
        content: [{ type: "text" as const, text: `Message sent to seller ${args.seller_id}.${result.threadId ? ` Thread ID: \`${result.threadId}\`.` : ""}${result.messageId ? ` Message ID: \`${result.messageId}\`.` : ""}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error starting seller thread: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  };
}

export function createSendThreadMessageHandler(client: FacebookClient) {
  return async (args: { thread_id: string; message: string }) => {
    try {
      const result = await client.sendSellerMessage({ threadId: args.thread_id, message: args.message });
      return {
        content: [{ type: "text" as const, text: `Message sent in thread \`${result.threadId || args.thread_id}\`.${result.messageId ? ` Message ID: \`${result.messageId}\`.` : ""}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error sending message: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  };
}
