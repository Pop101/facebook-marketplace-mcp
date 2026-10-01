import type {
  MarketplaceListing,
  MarketplaceListingDetail,
  SearchResult,
} from "./types.js";

export function parseSearchResponse(data: unknown): SearchResult {
  try {
    const root = data as any;
    const feedUnits =
      root?.data?.marketplace_search?.feed_units ??
      root?.data?.marketplace_search?.feed_units;

    if (!feedUnits) {
      return { listings: [], hasNextPage: false, endCursor: null };
    }

    const edges = feedUnits.edges ?? [];
    const pageInfo = feedUnits.page_info ?? {};

    const listings: MarketplaceListing[] = edges
      .map((edge: any) => {
        const listing = edge?.node?.listing;
        if (!listing) return null;

        return {
          id: listing.id ?? "",
          title: listing.marketplace_listing_title ?? "",
          price:
            listing.listing_price?.formatted_amount ??
            listing.listing_price?.amount ??
            "N/A",
          location:
            listing.location?.reverse_geocode?.city_page?.display_name ??
            listing.location?.reverse_geocode?.city ??
            "Unknown",
          imageUrl: listing.primary_listing_photo?.image?.uri ?? "",
          sellerId: listing.marketplace_listing_seller?.id ?? "",
          sellerName: listing.marketplace_listing_seller?.name ?? "Unknown",
          postedDate: listing.creation_time
            ? new Date(listing.creation_time * 1000).toISOString()
            : "",
          url: `https://www.facebook.com/marketplace/item/${listing.id}/`,
          isPending: listing.is_pending ?? false,
        };
      })
      .filter(Boolean) as MarketplaceListing[];

    return {
      listings,
      hasNextPage: pageInfo.has_next_page ?? false,
      endCursor: pageInfo.end_cursor ?? null,
    };
  } catch {
    return { listings: [], hasNextPage: false, endCursor: null };
  }
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
