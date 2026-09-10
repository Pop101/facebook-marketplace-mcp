import type {
  FacebookSession,
  SearchParams,
  SearchResult,
  MarketplaceListingDetail,
  MarketplaceMessage,
  MessageThread,
} from "./types.js";
import {
  extractChromeCookies,
  extractCookieHeaderCookies,
  cookiesToHeader,
  getCookieValue,
} from "./auth.js";
import {
  MARKETPLACE_SEARCH_DOC_ID,
  LOCATION_SEARCH_DOC_ID,
  LISTING_DETAIL_DOC_ID,
  buildSearchVariables,
  buildLocationSearchVariables,
} from "./queries.js";
import { parseSearchResponse, parseListingDetailFromPage } from "./parser.js";
import { RateLimiter } from "../utils/rate-limit.js";

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const MARKETPLACE_URL = "https://www.facebook.com/marketplace/";
const FACEBOOK_URL = "https://www.facebook.com";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export class FacebookClient {
  private session: FacebookSession | null = null;
  private rateLimiter: RateLimiter;
  private reqCounter = 0;
  private chromeProfile: string;

  constructor(
    options: {
      maxRequestsPerMinute?: number;
      chromeProfile?: string;
    } = {}
  ) {
    this.rateLimiter = new RateLimiter(options.maxRequestsPerMinute ?? 3);
    this.chromeProfile = options.chromeProfile ?? "Default";
  }

  async ensureSession(): Promise<FacebookSession> {
    if (this.session) return this.session;
    return this.initSession();
  }

  async initSession(): Promise<FacebookSession> {
    const configuredCookieHeader = process.env.FACEBOOK_COOKIE_HEADER?.trim();
    if (!configuredCookieHeader && process.platform !== "darwin") {
      throw new Error(
        "FACEBOOK_COOKIE_HEADER is required on non-macOS hosts. Export the Cookie header from an authenticated Facebook browser session."
      );
    }

    const cookies = configuredCookieHeader
      ? extractCookieHeaderCookies(configuredCookieHeader)
      : extractChromeCookies("facebook.com", this.chromeProfile);

    if (cookies.length === 0) {
      throw new Error(
        "No Facebook cookies found. Set FACEBOOK_COOKIE_HEADER or log into Facebook in Chrome."
      );
    }

    const userId = getCookieValue(cookies, "c_user");
    if (!userId) {
      throw new Error(
        "No c_user cookie found. Set FACEBOOK_COOKIE_HEADER from an authenticated Facebook session or log into Facebook in Chrome."
      );
    }

    const cookieHeader = configuredCookieHeader ?? cookiesToHeader(cookies);

    // Fetch marketplace page to extract tokens
    const tokens = await this.extractTokens(cookieHeader);

    this.session = {
      cookies,
      cookieHeader,
      userId,
      ...tokens,
    };

    return this.session;
  }

  private async extractTokens(cookieHeader: string): Promise<{
    fbDtsg: string;
    lsd: string;
    jazoest: string;
    clientRevision: string;
  }> {
    await this.rateLimiter.wait();

    const res = await fetch(MARKETPLACE_URL, {
      headers: {
        ...BROWSER_HEADERS,
        Cookie: cookieHeader,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(
        `Failed to fetch marketplace page: ${res.status} ${res.statusText}`
      );
    }

    const html = await res.text();

    // Extract fb_dtsg from DTSGInitData or DTSGInitialData
    const dtsgMatch =
      html.match(/"DTSGInitData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/) ??
      html.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/) ??
      html.match(/"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/);

    if (!dtsgMatch) {
      throw new Error(
        "Failed to extract fb_dtsg token. Session may be expired — try logging into Facebook in Chrome again."
      );
    }
    const fbDtsg = dtsgMatch[1];

    // Extract jazoest
    const jazoestMatch = html.match(/jazoest=(\d+)/);
    const jazoest = jazoestMatch ? jazoestMatch[1] : "";

    // Extract lsd
    const lsdMatch = html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/) ??
      html.match(/name="lsd"\s+value="([^"]+)"/);
    const lsd = lsdMatch ? lsdMatch[1] : "";

    // Extract client revision
    const revMatch = html.match(/"client_revision"\s*:\s*(\d+)/) ??
      html.match(/__spin_r:\s*(\d+)/);
    const clientRevision = revMatch ? revMatch[1] : "1";

    return { fbDtsg, lsd, jazoest, clientRevision };
  }

  private async graphqlRequest(
    docId: string,
    variables: Record<string, unknown>
  ): Promise<unknown> {
    const session = await this.ensureSession();
    await this.rateLimiter.wait();

    this.reqCounter++;

    const body = new URLSearchParams({
      fb_dtsg: session.fbDtsg,
      lsd: session.lsd,
      jazoest: session.jazoest,
      doc_id: docId,
      variables: JSON.stringify(variables),
      __a: "1",
      __req: this.reqCounter.toString(36),
      __rev: session.clientRevision,
    });

    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        Cookie: session.cookieHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        Origin: "https://www.facebook.com",
        Referer: "https://www.facebook.com/marketplace/",
        "X-FB-LSD": session.lsd,
      },
      body: body.toString(),
    });

    if (res.status === 401 || res.status === 403) {
      // Session expired — clear and retry once
      this.session = null;
      throw new Error("Session expired. Re-initializing on next request.");
    }

    if (!res.ok) {
      throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`);
    }

    let text = await res.text();

    // Strip Facebook's anti-JSONP prefix
    const jsonStart = text.indexOf("{");
    if (jsonStart > 0) {
      text = text.slice(jsonStart);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Failed to parse GraphQL response: ${text.slice(0, 200)}`);
    }
  }

  private async mercuryRequest(
    path: string,
    fields: Record<string, string>
  ): Promise<unknown> {
    const session = await this.ensureSession();
    await this.rateLimiter.wait();
    this.reqCounter++;

    const body = new URLSearchParams({
      ...fields,
      __user: session.userId,
      __a: "1",
      __req: this.reqCounter.toString(36),
      __rev: session.clientRevision,
      fb_dtsg: session.fbDtsg,
      jazoest: session.jazoest,
      lsd: session.lsd,
    });
    const res = await fetch(new URL(path, FACEBOOK_URL), {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        Cookie: session.cookieHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        Origin: FACEBOOK_URL,
        Referer: "https://www.facebook.com/messages/",
        "X-FB-LSD": session.lsd,
      },
      body: body.toString(),
    });

    if (res.status === 401 || res.status === 403) {
      this.clearSession();
      throw new Error("Session expired. Re-initializing on next request.");
    }
    if (!res.ok) {
      throw new Error(`Facebook messaging request failed: ${res.status} ${res.statusText}`);
    }
    return parseFacebookResponse(await res.text());
  }

  async searchListings(params: SearchParams): Promise<SearchResult> {
    const variables = buildSearchVariables(params);
    const data = await this.graphqlRequest(MARKETPLACE_SEARCH_DOC_ID, variables);
    return parseSearchResponse(data);
  }

  async getListingDetail(listingId: string): Promise<MarketplaceListingDetail> {
    // If we have a doc_id for listing detail, use GraphQL
    if (LISTING_DETAIL_DOC_ID) {
      const data = await this.graphqlRequest(LISTING_DETAIL_DOC_ID, {
        targetId: listingId,
      });
      // Parse response (would need a dedicated parser)
      return data as MarketplaceListingDetail;
    }

    // Fallback: fetch the listing page directly and parse embedded data
    const session = await this.ensureSession();
    await this.rateLimiter.wait();

    const url = `https://www.facebook.com/marketplace/item/${listingId}/`;
    const res = await fetch(url, {
      headers: {
        ...BROWSER_HEADERS,
        Cookie: session.cookieHeader,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch listing ${listingId}: ${res.status}`);
    }

    const html = await res.text();
    return parseListingDetailFromPage(html, listingId);
  }

  async searchLocation(
    query: string
  ): Promise<Array<{ name: string; latitude: number; longitude: number }>> {
    const variables = buildLocationSearchVariables(query);
    const data = await this.graphqlRequest(LOCATION_SEARCH_DOC_ID, variables);

    try {
      const results = (data as any)?.data?.city_street_search?.street_results?.edges ?? [];
      return results.map((edge: any) => ({
        name: edge.node?.single_line_address ?? edge.node?.subtitle ?? "Unknown",
        latitude: edge.node?.location?.latitude ?? 0,
        longitude: edge.node?.location?.longitude ?? 0,
      }));
    } catch {
      return [];
    }
  }

  async checkMessages(limit = 20): Promise<MessageThread[]> {
    const data = await this.mercuryRequest("/ajax/mercury/threadlist_info.php", {
      "folder[0]": "inbox",
      "folder[1]": "other",
      limit: String(limit),
      load_messages: "false",
      load_read_receipts: "false",
    });
    return parseMessageThreads(data);
  }

  async getMessageThread(
    threadId: string,
    limit = 20
  ): Promise<MarketplaceMessage[]> {
    const data = await this.mercuryRequest("/ajax/mercury/thread_info.php", {
      "thread_ids[0]": threadId,
      message_limit: String(limit),
      load_messages: "true",
      load_read_receipts: "false",
    });
    return parseMessages(data);
  }

  async sendSellerMessage(args: {
    message: string;
    threadId?: string;
    sellerId?: string;
  }): Promise<{ threadId: string; messageId: string }> {
    if (!args.threadId && !args.sellerId) {
      throw new Error("Provide either an existing thread ID or a seller ID.");
    }
    const session = await this.ensureSession();
    const offlineThreadingId = `${Date.now()}${Math.floor(Math.random() * 1_000_000_000)
      .toString()
      .padStart(9, "0")}`;
    const fields: Record<string, string> = {
      "message_batch[0][action_type]": "ma-type:user-generated-message",
      "message_batch[0][author]": `fbid:${session.userId}`,
      "message_batch[0][body]": args.message,
      "message_batch[0][offline_threading_id]": offlineThreadingId,
      "message_batch[0][source]": "source:chat:web",
      "message_batch[0][timestamp]": String(Date.now()),
      client: "mercury",
    };
    if (args.threadId) {
      fields["message_batch[0][thread_id]"] = args.threadId;
    } else if (args.sellerId) {
      fields["message_batch[0][specific_to_list][1]"] = `fbid:${args.sellerId}`;
    }

    const data = await this.mercuryRequest("/ajax/mercury/send_messages.php", fields);
    const response = findFirstObject(data, (value) =>
      typeof value.message_id === "string" || typeof value.messageId === "string"
    );
    const messageId = stringField(response, "message_id", "messageId") ?? "";
    const threadId =
      stringField(response, "thread_id", "threadId", "thread_fbid") ??
      args.threadId ??
      "";
    if (!messageId || !threadId) {
      throw new Error("Facebook did not confirm that the message was sent.");
    }
    return { threadId, messageId };
  }

  clearSession() {
    this.session = null;
    this.reqCounter = 0;
  }
}

function parseFacebookResponse(text: string): unknown {
  const jsonStart = text.search(/[\[{]/);
  if (jsonStart < 0) {
    throw new Error(`Failed to parse Facebook response: ${text.slice(0, 200)}`);
  }
  let response: unknown;
  try {
    response = JSON.parse(text.slice(jsonStart));
  } catch {
    throw new Error(`Failed to parse Facebook response: ${text.slice(0, 200)}`);
  }
  const error = findFirstObject(response, (record) =>
    typeof record.error === "string" ||
    typeof record.error === "number" ||
    typeof record.errorSummary === "string"
  );
  if (error) {
    throw new Error(
      stringField(error, "errorSummary", "errorDescription", "error") ??
        "Facebook rejected the request."
    );
  }
  return response;
}

function stringField(value: unknown, ...names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const field = record[name];
    if (typeof field === "string" || typeof field === "number") return String(field);
  }
  return undefined;
}

function numberField(value: unknown, ...names: string[]): number {
  const text = stringField(value, ...names);
  return text && Number.isFinite(Number(text)) ? Number(text) : 0;
}

function findObjects(value: unknown, predicate: (record: Record<string, unknown>) => boolean) {
  const found: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  const visit = (current: unknown) => {
    if (!current || typeof current !== "object" || visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    const record = current as Record<string, unknown>;
    if (predicate(record)) found.push(record);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}

function findFirstObject(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  return findObjects(value, predicate)[0];
}

function parseMessageThreads(data: unknown): MessageThread[] {
  const seen = new Set<string>();
  return findObjects(data, (record) =>
    typeof record.thread_fbid === "string" || typeof record.thread_id === "string"
  )
    .map((record) => {
      const id = stringField(record, "thread_fbid", "thread_id") ?? "";
      const participants = Array.isArray(record.participants)
        ? record.participants
            .map((participant) => stringField(participant, "name", "short_name"))
            .filter((name): name is string => Boolean(name))
        : [];
      return {
        id,
        title: stringField(record, "name", "thread_name") ?? participants.join(", "),
        snippet: stringField(record, "snippet", "snippet_text", "last_message_text") ?? "",
        updatedAt: stringField(record, "timestamp", "last_message_timestamp") ?? "",
        unreadCount: numberField(record, "unread_count", "unreadCount"),
        participantNames: participants,
      };
    })
    .filter((thread) => Boolean(thread.id) && !seen.has(thread.id) && Boolean(seen.add(thread.id)));
}

function parseMessages(data: unknown): MarketplaceMessage[] {
  const seen = new Set<string>();
  return findObjects(data, (record) =>
    typeof record.message_id === "string" &&
    (typeof record.body === "string" || typeof record.text === "string")
  )
    .map((record) => ({
      id: stringField(record, "message_id") ?? "",
      senderId: stringField(record, "author", "sender_fbid", "sender_id") ?? "",
      text: stringField(record, "body", "text") ?? "",
      sentAt: stringField(record, "timestamp", "timestamp_precise") ?? "",
    }))
    .filter((message) => Boolean(message.id) && !seen.has(message.id) && Boolean(seen.add(message.id)));
}
