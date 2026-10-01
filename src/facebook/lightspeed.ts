import type { MarketplaceMessage, MessageThread } from "./types.js";

interface Thread extends MessageThread {
  parentId: string;
  syncGroup: string;
  participantIds: Set<string>;
}
interface Message extends MarketplaceMessage { threadId: string; offlineId: string; }
interface Outgoing { threadId: string; offlineId: string; text: string; }
const scalar = (v: unknown): string => typeof v === "string" || typeof v === "number" ? String(v) : "";
const value = (v: unknown): unknown => Array.isArray(v) ? v[0] === 19 ? v[1] : undefined : v;

/** Preserve 64-bit protocol identifiers without rounding them through Number. */
export function parseWireJson(text: string): unknown {
  const safe = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (/^-?\d{16,}$/.test(token) && (BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(token) < BigInt(Number.MIN_SAFE_INTEGER))) return JSON.stringify(token);
    return token;
  });
  return JSON.parse(safe);
}

/** Gateway frames wrap JSON in a binary envelope; do not log that envelope. */
export function packetObjects(packet: string | Buffer): unknown[] {
  const text = packet.toString();
  const objects: unknown[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try { objects.push(parseWireJson(text.slice(start, i + 1))); start = i; } catch { /* Not a JSON frame. */ }
        break;
      }
    }
  }
  return objects;
}

/** A read-only projection of observed server data, not a Lightspeed VM. */
export class MessengerSnapshot {
  readonly threads = new Map<string, Thread>();
  readonly messages = new Map<string, Message>();
  readonly outgoing: Outgoing[] = [];
  readonly acknowledgements = new Map<string, string>();
  readonly failedOfflineIds = new Set<string>();
  readonly contacts = new Map<string, string>();
  readonly participants = new Map<string, Set<string>>();
  accountId = "";
  payloadCount = 0;
  marketplaceLoaded = false;

  ingestHtml(html: string): void {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        if (node[0] === "CurrentUserInitialData" && node[2]?.USER_ID) this.accountId = scalar(node[2].USER_ID);
        node.forEach(visit);
      } else if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        const request = record.lightspeed_web_request as {payload?: unknown} | undefined;
        if (typeof request?.payload === "string") this.ingestPacket(request.payload);
        Object.values(record).filter(v => v && typeof v === "object").forEach(visit);
      }
    };
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      try { visit(parseWireJson(match[1])); } catch { /* Non-JSON script. */ }
    }
  }

  ingestPacket(packet: string | Buffer, sent = false): void {
    for (const object of packetObjects(packet)) this.ingest(object, sent);
  }

  private ingest(node: unknown, sent = false, depth = 0): void {
    if (depth > 100) return;
    if (typeof node === "string" && /^[\[{]/.test(node)) {
      try { this.ingest(parseWireJson(node), sent, depth + 1); } catch { /* Plain text. */ }
    } else if (Array.isArray(node)) {
      if (node[0] === "CurrentUserInitialData" && node[2]?.USER_ID) this.accountId = scalar(node[2].USER_ID);
      for (const child of node) if (child && typeof child === "object") this.ingest(child, sent, depth + 1);
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (!sent && Array.isArray(record.step)) {
        this.payloadCount++;
        this.collectOperations(record.step);
        return;
      }
      if (sent && record.label === "46" && typeof record.payload === "string") {
        try {
          const payload = parseWireJson(record.payload) as Record<string, unknown>;
          this.outgoing.push({threadId: scalar(payload.thread_id), offlineId: scalar(payload.otid), text: scalar(payload.text)});
        } catch { /* No confirmed send request. */ }
      }
      for (const [key, child] of Object.entries(record)) {
        if (typeof child === "object" || (key === "payload" && typeof child === "string")) this.ingest(child, sent, depth + 1);
      }
    }
  }

  private collectOperations(node: unknown): void {
    if (!Array.isArray(node)) return;
    if (node[0] === 5 && typeof node[1] === "string") {
      this.apply(node[1], node.slice(2).map(value));
      return;
    }
    for (const child of node) this.collectOperations(child);
  }

  private apply(name: string, a: unknown[]): void {
    const s = (i: number) => scalar(a[i]);
    if (name === "deleteThenInsertThread" || name === "updateOrInsertThread") {
      const id = s(7), newer = name === "updateOrInsertThread";
      if (!id || (this.threads.has(id) && Number(this.threads.get(id)!.updatedAt) > Number(s(0)))) return;
      this.threads.set(id, {id, title: s(3), snippet: s(2), updatedAt: s(0),
        unreadCount: newer ? Number(s(0)) > Number(s(1)) ? 1 : 0 : Number(s(89)) || 0,
        participantNames: [], participantIds: this.participants.get(id) ?? new Set(),
        parentId: s(newer ? 38 : 35), syncGroup: s(newer ? 82 : 66)});
    } else if (name === "upsertSyncGroupThreadsRange" && s(1) === "-12" && s(0) === "1" && a[4] === false) {
      this.marketplaceLoaded = true;
    } else if (["upsertMessage", "insertMessage", "deleteThenInsertMessage"].includes(name)) {
      if (!s(8) || !s(3) || !s(5)) return;
      if (a[17] === true) { this.messages.delete(s(8)); return; }
      this.messages.set(s(8), {id: s(8), threadId: s(3), offlineId: s(9), senderId: s(10), text: s(0), sentAt: s(5)});
    } else if (name === "verifyContactRowExists") {
      if (s(0) && s(3)) this.contacts.set(s(0), s(3));
    } else if (name === "addParticipantIdToGroupThread") {
      const ids = this.participants.get(s(0)) ?? new Set<string>();
      ids.add(s(1)); this.participants.set(s(0), ids);
      const thread = this.threads.get(s(0)); if (thread) thread.participantIds = ids;
    } else if (name === "replaceOptimsiticMessage" || name === "replaceOptimisticMessage") {
      if (s(0) && s(1)) this.acknowledgements.set(s(0), s(1));
    } else if (name === "markOptimisticMessageFailed") this.failedOfflineIds.add(s(0));
    else if (name === "handleFailedTask") this.failedOfflineIds.add(s(1));
  }

  marketplaceThreads(limit: number): MessageThread[] {
    if (!this.payloadCount || !this.marketplaceLoaded) throw new Error("Marketplace folder did not finish loading; this is not an empty inbox.");
    return [...this.threads.values()].filter(t => t.parentId === "-12")
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)).slice(0, limit)
      .map(t => ({id: t.id, title: t.title, snippet: t.snippet, updatedAt: t.updatedAt, unreadCount: t.unreadCount,
        participantNames: [...t.participantIds].filter(id => id !== this.accountId).map(id => this.contacts.get(id)).filter((n): n is string => !!n)}));
  }

  threadMessages(threadId: string, limit: number): MarketplaceMessage[] {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Requested thread was not returned by Messenger; no messages were confirmed.");
    if (thread.syncGroup === "95") throw new Error("This thread is end-to-end encrypted. Plaintext history is unavailable through this transport; restore it in Messenger.");
    const messages = [...this.messages.values()].filter(m => m.threadId === threadId)
      .sort((a, b) => Number(a.sentAt) - Number(b.sentAt)).slice(-limit);
    if (!messages.length) throw new Error("Messenger returned no message data for this thread; an empty conversation was not confirmed.");
    return messages.map(({id, senderId, text, sentAt}) => ({id, senderId, text: text || "[Non-text message]", sentAt}));
  }

  receipt(threadId: string, text: string, after: number): {threadId: string; messageId: string} | undefined {
    for (const outgoing of this.outgoing.filter(o => o.threadId === threadId && o.text === text)) {
      if (this.failedOfflineIds.has(outgoing.offlineId)) throw new Error("Facebook rejected the outgoing message.");
      const id = this.acknowledgements.get(outgoing.offlineId);
      const message = [...this.messages.values()].find(m => m.threadId === threadId && m.senderId === this.accountId && m.text === text && Number(m.sentAt) >= after && (m.offlineId === outgoing.offlineId || m.id === id));
      if (id || message) return {threadId, messageId: id ?? message!.id};
    }
    return undefined;
  }
}
