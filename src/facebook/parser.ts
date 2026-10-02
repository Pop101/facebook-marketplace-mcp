import { z } from "zod";
import type {
  MarketplaceListing,
  MarketplaceListingDetail,
  SearchPage,
} from "./types.js";

// Validate the search envelope instead of converting integration failures to zero matches.
const searchListingSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
  marketplace_listing_title: z.string().min(1),
  listing_price: z.object({
    formatted_amount: z.string().nullish(),
    amount: z.union([z.string(), z.number()]).nullish(),
  }).nullish(),
  location: z.object({
    reverse_geocode: z.object({
      city_page: z.object({display_name: z.string().nullish()}).nullish(),
      city: z.string().nullish(),
      state: z.string().nullish(),
    }).nullish(),
  }).nullish(),
  primary_listing_photo: z.object({
    image: z.object({uri: z.string().nullish()}).nullish(),
  }).nullish(),
  marketplace_listing_seller: z.object({
    id: z.string().nullish(),
    name: z.string().nullish(),
  }).nullish(),
  creation_time: z.union([z.number(), z.string()]).nullish(),
  delivery_types: z.array(z.string()).nullish(),
  is_pending: z.boolean().nullish(),
  is_sold: z.boolean().nullish(),
});

const searchResponseSchema = z.object({
  data: z.object({
    marketplace_search: z.object({
      feed_units: z.object({
        edges: z.array(z.object({
          node: z.object({listing: searchListingSchema.nullish()}).nullable(),
        })),
        page_info: z.object({
          has_next_page: z.boolean(),
          end_cursor: z.string().min(1).nullish(),
        }),
      }),
    }),
  }),
});

export function parseSearchResponse(data: unknown): SearchPage {
  const parsed = searchResponseSchema.safeParse(data);
  if (!parsed.success) {
    // Never echo raw response values or Zod issues: they may contain private data.
    throw new Error("Invalid Marketplace search response; this is not a confirmed empty search.");
  }
  const feed = parsed.data.data.marketplace_search.feed_units;
  if (feed.page_info.has_next_page && !feed.page_info.end_cursor) {
    throw new Error("Invalid Marketplace search response: another page was indicated without a cursor.");
  }

  const listings: MarketplaceListing[] = [];
  let skippedFeedUnits = 0;
  for (const edge of feed.edges) {
    const listing = edge.node?.listing;
    if (!listing) {
      skippedFeedUnits++;
      continue;
    }
    const millis = Number(listing.creation_time) * 1000;
    const validDate = listing.creation_time != null && listing.creation_time !== ""
      && Number.isFinite(millis) && Math.abs(millis) <= 8.64e15;
    const geo = listing.location?.reverse_geocode;
    listings.push({
      id: listing.id,
      title: listing.marketplace_listing_title,
      price: String(listing.listing_price?.formatted_amount ?? listing.listing_price?.amount ?? "N/A"),
      location: geo?.city_page?.display_name ?? ([geo?.city, geo?.state].filter(Boolean).join(", ") || "Unknown"),
      imageUrl: listing.primary_listing_photo?.image?.uri ?? "",
      sellerId: listing.marketplace_listing_seller?.id ?? "",
      sellerName: listing.marketplace_listing_seller?.name ?? "Unknown",
      postedDate: validDate ? new Date(millis).toISOString() : "",
      url: `https://www.facebook.com/marketplace/item/${listing.id}/`,
      isPending: listing.is_pending ?? false,
      isSold: listing.is_sold ?? undefined,
      deliveryTypes: listing.delivery_types ?? undefined,
    });
  }
  return {
    listings,
    hasNextPage: feed.page_info.has_next_page,
    endCursor: feed.page_info.has_next_page ? feed.page_info.end_cursor! : null,
    skippedFeedUnits,
  };
}

export function parseListingDetailFromGraphQL(
  data: unknown,
  listingId: string
): MarketplaceListingDetail {
  // The PDP response contains several GroupCommerceProductItem copies; the
  // fully-hydrated one is the node that carries both a title and a seller.
  let best: any = null;
  let bestScore = -1;
  const visit = (node: any): void => {
    if (node && typeof node === "object") {
      const nodeId = String(node.id ?? "");
      const entId = String(node.reportable_ent_id ?? "");
      const productId = String(node.product_item?.id ?? "");
      const matchesListing =
        nodeId === String(listingId) ||
        entId === String(listingId) ||
        productId === String(listingId);
      if (typeof node.marketplace_listing_title === "string" && matchesListing) {
        const score = Object.keys(node).length;
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") visit(value);
      }
    }
  };
  visit(data);

  if (!best) {
    throw new Error(`Listing ${listingId} not found in PDP response`);
  }

  const detail: MarketplaceListingDetail = {
    id:
      String(best.reportable_ent_id ?? "") === String(listingId)
        ? String(best.reportable_ent_id)
        : String(best.product_item?.id ?? "") === String(listingId)
          ? String(best.product_item.id)
          : String(best.id ?? listingId),
    title: best.marketplace_listing_title ?? "",
    description: best.redacted_description?.text ?? "",
    price:
      best.listing_price?.formatted_amount_zeros_stripped ??
      best.listing_price?.formatted_amount ??
      best.listing_price?.amount ??
      "N/A",
    location:
      best.location_text?.text ??
      best.location?.reverse_geocode?.city_page?.display_name ??
      best.location?.reverse_geocode?.city ??
      "Unknown",
    imageUrl: best.primary_listing_photo?.image?.uri ?? "",
    images: [],
    sellerId: best.marketplace_listing_seller?.id ?? "",
    sellerName: best.marketplace_listing_seller?.name ?? "Unknown",
    postedDate: best.creation_time
      ? new Date(best.creation_time * 1000).toISOString()
      : "",
    url: `https://www.facebook.com/marketplace/item/${listingId}/`,
    isPending: best.is_pending ?? false,
    condition: best.condition ?? "",
    seller: {
      id: best.marketplace_listing_seller?.id ?? "",
      name: best.marketplace_listing_seller?.name ?? "Unknown",
      profileUrl: best.marketplace_listing_seller?.id
        ? `https://www.facebook.com/profile.php?id=${best.marketplace_listing_seller.id}`
        : "",
    },
  };
  return detail;
}

export function parseListingPhotosFromMediaResponse(data: unknown): string[] {
  const uris: string[] = [];
  const visit = (node: any): void => {
    if (node && typeof node === "object") {
      if (Array.isArray(node.listing_photos)) {
        for (const photo of node.listing_photos) {
          const uri = photo?.image?.uri;
          if (typeof uri === "string" && !uris.includes(uri)) uris.push(uri);
        }
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") visit(value);
      }
    }
  };
  visit(data);
  return uris;
}

export function parseListingDetailFromPage(
  html: string,
  listingId: string
): MarketplaceListingDetail {
  // Facebook embeds listing data as JSON in script tags.
  // Look for structured data or relay-style data payloads.

  const detail: MarketplaceListingDetail = {
    id: listingId,
    title: "",
    description: "",
    price: "",
    location: "",
    imageUrl: "",
    sellerId: "",
    images: [],
    sellerName: "",
    postedDate: "",
    url: `https://www.facebook.com/marketplace/item/${listingId}/`,
    isPending: false,
    condition: "",
    seller: { id: "", name: "", profileUrl: "" },
  };

  // Try to extract from meta tags first (most reliable)
  const titleMatch = html.match(
    /<meta\s+property="og:title"\s+content="([^"]*)"/
  );
  if (titleMatch) detail.title = decodeHtmlEntities(titleMatch[1]);

  const descMatch = html.match(
    /<meta\s+property="og:description"\s+content="([^"]*)"/
  );
  if (descMatch) detail.description = decodeHtmlEntities(descMatch[1]);

  const imageMatch = html.match(
    /<meta\s+property="og:image"\s+content="([^"]*)"/
  );
  if (imageMatch) {
    detail.imageUrl = decodeHtmlEntities(imageMatch[1]);
    detail.images.push(detail.imageUrl);
  }

  // Try to extract price from embedded JSON
  const priceMatch =
    html.match(/"formatted_amount"\s*:\s*"([^"]+)"/) ??
    html.match(/"price"\s*:\s*"([^"]+)"/) ??
    html.match(/\"amount\"\s*:\s*"([^"]+)"/);
  if (priceMatch) detail.price = priceMatch[1];

  // Extract additional images
  const imageRegex = /marketplace_listing_photos.*?"uri"\s*:\s*"([^"]+)"/g;
  let imgMatch;
  while ((imgMatch = imageRegex.exec(html)) !== null) {
    const url = imgMatch[1].replace(/\\\//g, "/");
    if (!detail.images.includes(url)) {
      detail.images.push(url);
    }
  }

  // Extract seller name
  const sellerMatch = html.match(
    /"marketplace_listing_seller"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/
  );
  if (sellerMatch) {
    detail.sellerName = sellerMatch[1];
    detail.seller.name = sellerMatch[1];
  }

  const sellerIdMatch = html.match(
    /"marketplace_listing_seller"\s*:\s*\{[^}]*"id"\s*:\s*"(\d+)"/
  );
  if (sellerIdMatch) {
    detail.sellerId = sellerIdMatch[1];
    detail.seller.id = sellerIdMatch[1];
  }

  // Extract condition
  const conditionMatch = html.match(
    /"condition_text"\s*:\s*"([^"]+)"/
  ) ?? html.match(/"condition"\s*:\s*"([^"]+)"/);
  if (conditionMatch) detail.condition = conditionMatch[1];

  // Extract location
  const locationMatch = html.match(
    /"location_text"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]+)"/
  ) ?? html.match(/"reverse_geocode_city"\s*:\s*"([^"]+)"/);
  if (locationMatch) detail.location = locationMatch[1];

  return detail;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}
