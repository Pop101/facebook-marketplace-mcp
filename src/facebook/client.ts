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
  PDP_MEDIA_DOC_ID,
  buildSearchVariables,
  buildListingDetailVariables,
  buildListingMediaVariables,
  buildLocationSearchVariables,
} from "./queries.js";
import {
  parseSearchResponse,
  parseListingDetailFromGraphQL,
  parseListingPhotosFromMediaResponse,
  parseListingDetailFromPage,
} from "./parser.js";
import { RateLimiter } from "../utils/rate-limit.js";
import { postWithCurl, parseGraphqlResponse } from "./transport.js";
import path from "node:path";
import { MessengerBrowser } from "./messenger.js";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CURL_IMPERSONATE = path.join(PROJECT_ROOT, "bin", "curl_chrome131");

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
  private messenger = new MessengerBrowser(async () => (await this.ensureSession()).userId);

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

  /**
   * POST through curl-impersonate (Chrome TLS fingerprint). Facebook rejects
   * GraphQL POSTs from plain fetch/curl with error 1357054 — the request body
   * is identical either way, only the TLS/HTTP fingerprint differs.
   */
  private impersonatedPost(
    url: string,
    headers: Record<string, string>,
    body: string
  ): Promise<{ status: number; text: string }> {
    return postWithCurl(CURL_IMPERSONATE, url, headers, body);
  }

  private async graphqlRequest(
    docId: string,
    variables: Record<string, unknown>,
    friendlyName?: string
  ): Promise<unknown> {
    const session = await this.ensureSession();
    await this.rateLimiter.wait();

    this.reqCounter++;

    const body = new URLSearchParams({
      fb_dtsg: session.fbDtsg,
      lsd: session.lsd,
      jazoest: session.jazoest,
      av: session.userId,
      __user: session.userId,
      fb_api_caller_class: "RelayModern",
      ...(friendlyName ? { fb_api_req_friendly_name: friendlyName } : {}),
      server_timestamps: "true",
      doc_id: docId,
      variables: JSON.stringify(variables),
      __a: "1",
      __req: this.reqCounter.toString(36),
      __rev: session.clientRevision,
    });

    const headers: Record<string, string> = {
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
      "X-ASBD-ID": "359341",
    };
    if (friendlyName) headers["X-FB-Friendly-Name"] = friendlyName;

    const { status, text: rawText } = await this.impersonatedPost(GRAPHQL_URL, headers, body.toString());

    if (status === 401 || status === 403) {
      // Session expired — clear and retry once
      this.session = null;
      throw new Error("Session expired. Re-initializing on next request.");
    }

    if (status !== 200) {
      throw new Error(`GraphQL request failed: ${status}`);
    }

    return parseGraphqlResponse(rawText);
  }

  async searchListings(params: SearchParams): Promise<SearchResult> {
    const variables = buildSearchVariables(params);
    const data = await this.graphqlRequest(MARKETPLACE_SEARCH_DOC_ID, variables, "CometMarketplaceSearchContentPaginationQuery");
    return parseSearchResponse(data);
  }

  async getListingDetail(listingId: string): Promise<MarketplaceListingDetail> {
    // Primary path: replay the PDP GraphQL query, then the media-viewer query
    // for the full photo set.
    if (LISTING_DETAIL_DOC_ID) {
      const data = await this.graphqlRequest(
        LISTING_DETAIL_DOC_ID,
        buildListingDetailVariables(listingId),
        "MarketplacePDPContainerQuery"
      );
      const detail = parseListingDetailFromGraphQL(data, listingId);

      try {
        const mediaData = await this.graphqlRequest(
          PDP_MEDIA_DOC_ID,
          buildListingMediaVariables(listingId),
          "MarketplacePDPC2CMediaViewerWithImagesQuery"
        );
        detail.images = parseListingPhotosFromMediaResponse(mediaData);
        if (!detail.imageUrl && detail.images.length > 0) {
          detail.imageUrl = detail.images[0];
        }
      } catch {
        // Photos are best-effort; detail data stands on its own.
      }

      return detail;
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
    const data = await this.graphqlRequest(LOCATION_SEARCH_DOC_ID, variables, "CometMarketplaceLocationTypeaheadDataSourceQuery");

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
    return this.messenger.checkMessages(limit);
  }

  async getMessageThread(threadId: string, limit = 20): Promise<MarketplaceMessage[]> {
    return this.messenger.readThread(threadId, limit);
  }

  async sendSellerMessage(args: {
    message: string; threadId?: string; sellerId?: string; listingId?: string;
  }): Promise<{ threadId: string; messageId: string }> {
    if (!!args.threadId === !!args.sellerId) throw new Error("Provide exactly one thread ID or seller ID.");
    const message = args.message.trim();
    if (!message || message.length > 10000) throw new Error("Message must contain 1 to 10000 characters.");
    if (args.threadId) return this.messenger.sendThreadMessage(args.threadId, message);
    if (!args.listingId) throw new Error("listing_id is required for first contact; seller ID alone does not identify a Marketplace listing conversation.");
    if (!/^[1-9]\d{0,18}$/.test(args.listingId)) throw new Error("Invalid listing ID.");
    const listing = await this.getListingDetail(args.listingId);
    if (!listing.seller.id || listing.seller.id !== args.sellerId) throw new Error("Listing seller does not match seller_id. Nothing was sent.");
    return this.messenger.startSellerThread(args.listingId, args.sellerId!, message);
  }

  clearSession() {
    this.session = null;
    this.reqCounter = 0;
  }
}
