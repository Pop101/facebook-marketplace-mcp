import { z } from "zod";
import type { FacebookClient } from "../facebook/client.js";
import type { SearchResult } from "../facebook/types.js";

export const searchListingsSchema = {
  query: z.string().trim().min(1).describe("Search query. Also try model/name variants; Facebook can return unrelated results."),
  latitude: z.number().finite().min(-90).max(90).describe("Latitude of search center"),
  longitude: z.number().finite().min(-180).max(180).describe("Longitude of search center"),
  radius_km: z.number().finite().positive().default(50).describe("Requested radius in kilometers; Facebook may expand results. Verify each displayed location."),
  min_price: z.number().finite().nonnegative().optional().describe("Minimum price in dollars"),
  max_price: z.number().finite().nonnegative().optional().describe("Maximum price in dollars; zero means free"),
  category: z.string().min(1).optional().describe("Category ID"),
  delivery_method: z.enum(["local_pickup", "shipping", "all"]).default("local_pickup")
    .describe("Requested delivery scope, not a distance guarantee. Unknown listing delivery is labeled, not assumed."),
  limit: z.number().int().min(1).max(100).default(20)
    .describe("Requested page size, not a guaranteed result count (1-100). Facebook may return fewer or more; complete pages are never truncated."),
  cursor: z.string().min(1).max(32768).optional()
    .describe("Opaque next_cursor from the previous result. Pass unchanged with the same query, location, filters and page size."),
  max_pages: z.number().int().min(1).max(5).default(1)
    .describe("Maximum pages fetched in this call (1-5). Default 1 avoids long rate-limit waits; use next_cursor to continue. Multi-page calls can take minutes."),
};

const argumentsSchema = z.object(searchListingsSchema);
type SearchArguments = z.input<typeof argumentsSchema>;

/** Include continuation in text too, for clients that do not display structuredContent. */
export function formatSearchCoverage(result: SearchResult): string {
  return [
    `Pages fetched: ${result.pagesFetched}; stop_reason: ${result.stopReason}; has_next_page: ${result.hasNextPage}.`,
    `next_cursor: ${JSON.stringify(result.endCursor)}`,
    ...result.warnings.map(warning => `Warning: ${warning}`),
  ].join("\n");
}

export function createSearchHandler(client: Pick<FacebookClient, "searchListings">) {
  return async (input: SearchArguments) => {
    try {
      const parsed = argumentsSchema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid search arguments; check the documented bounds and delivery_method.");
      const args = parsed.data;
      if (args.min_price !== undefined && args.max_price !== undefined && args.min_price > args.max_price) {
        throw new Error("min_price must not exceed max_price.");
      }
      const result = await client.searchListings({
        query: args.query,
        latitude: args.latitude,
        longitude: args.longitude,
        radiusKm: args.radius_km,
        minPrice: args.min_price,
        maxPrice: args.max_price,
        category: args.category,
        deliveryMethod: args.delivery_method,
        limit: args.limit,
        cursor: args.cursor,
        maxPages: args.max_pages,
      });
      const scopeWarning = "Distance is unverified: Facebook search supplies city labels, not listing coordinates, and may expand beyond the requested radius. Check each displayed location; unknown delivery is not proof of pickup availability.";
      const summary = result.listings.map((listing, index) => [
        `${index + 1}. **${listing.title}** - ${listing.price}${listing.isPending ? " [PENDING]" : ""}${listing.isSold ? " [SOLD]" : ""}`,
        `   Location: ${listing.location} | Seller: ${listing.sellerName}${listing.sellerId ? ` (${listing.sellerId})` : ""}`,
        `   Posted: ${listing.postedDate || "unknown"} | Delivery: ${listing.deliveryTypes?.join(", ") || "unknown"}`,
        `   ${listing.url}`,
      ].join("\n")).join("\n\n");
      const text = [
        `Returned ${result.listings.length} listing(s) for "${args.query}" from the scanned pages. Delivery requested: ${args.delivery_method}.`,
        summary,
        formatSearchCoverage(result),
        `Warning: ${scopeWarning}`,
        "Search other model/name variants and deduplicate by listing ID. Exhausted means only that Facebook reports no more pages for this query, not that every relevant listing was found.",
      ].filter(Boolean).join("\n\n");
      return {
        content: [{type: "text" as const, text}],
        structuredContent: {
          query: args.query,
          requested_scope: {latitude: args.latitude, longitude: args.longitude, radius_km: args.radius_km, delivery_method: args.delivery_method},
          location_verification: "unverified",
          listings: result.listings.map(listing => ({
            id: listing.id, title: listing.title, price: listing.price,
            location: listing.location, url: listing.url, image_url: listing.imageUrl,
            seller_id: listing.sellerId, seller_name: listing.sellerName,
            posted_at: listing.postedDate || null,
            delivery_types: listing.deliveryTypes ?? null,
            is_pending: listing.isPending, is_sold: listing.isSold ?? null,
          })),
          pages_fetched: result.pagesFetched,
          has_next_page: result.hasNextPage,
          next_cursor: result.endCursor,
          stop_reason: result.stopReason,
          skipped_feed_units: result.skippedFeedUnits,
          excluded_non_pickup_listings: result.excludedListings,
          warnings: [...result.warnings, scopeWarning],
        },
        isError: result.stopReason === "page_error" || result.stopReason === "cursor_repeated",
      };
    } catch (error) {
      return {
        content: [{type: "text" as const, text: `Error searching listings: ${error instanceof Error ? error.message : String(error)}`}],
        isError: true,
      };
    }
  };
}
