// Known GraphQL doc_ids for Facebook Marketplace.
// These are hashed operation identifiers that Facebook rotates on deploys.
// Run `npm run capture-queries` to discover current values if these break.
// On a headless server, use `npx tsx scripts/capture-pagination-headless.ts`
// with FACEBOOK_COOKIE_HEADER set to re-discover the search query, and look
// for MarketplacePDPContainerQuery queryIDs embedded in a listing page.

export const MARKETPLACE_SEARCH_DOC_ID = "27212616558440397";
export const LOCATION_SEARCH_DOC_ID = "5585904654783609";

// Listing detail (PDP) queries. Captured from an item page's Relay preloaders:
// MarketplacePDPContainerQuery and MarketplacePDPC2CMediaViewerWithImagesQuery.
export const LISTING_DETAIL_DOC_ID = "28471475289186074";
export const PDP_MEDIA_DOC_ID = "10059604367394414";

export function buildListingDetailVariables(listingId: string) {
  return {
    feedbackSource: 56,
    feedLocation: "MARKETPLACE_MEGAMALL",
    referralSurfaceString: null,
    scale: 1,
    targetId: listingId,
    useDefaultActor: false,
    __relay_internal__pv__MarketplacePDPCometSimilarListingsrelayprovider: false,
    __relay_internal__pv__MarketplacePDPShouldShowRelatedSearchesrelayprovider: true,
    __relay_internal__pv__MarketplacePDPShouldShowLoggedOutSellerTrustrelayprovider: false,
    __relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider: false,
    __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
    __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
    __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
    __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "AUTO_TRANSLATE",
    __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
    __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
    __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
    __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
    __relay_internal__pv__MarketplacePDPShouldShowBSGRecommendationsrelayprovider: false,
    __relay_internal__pv__MarketplacePDPJobShouldShowSharedGroupsSectionrelayprovider: true,
    __relay_internal__pv__MarketplacePDPJobIsShareToGroupsEnabledOnCometrelayprovider: true,
  };
}

export function buildListingMediaVariables(listingId: string) {
  return { targetId: listingId };
}

export function buildSearchVariables(params: {
  query: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  minPrice?: number;
  maxPrice?: number;
  category?: string;
  limit: number;
  cursor?: string;
}) {
  const variables: Record<string, unknown> = {
    count: params.limit,
    params: {
      bqf: {
        callsite: "COMMERCE_MKTPLACE_WWW",
        query: params.query,
      },
      browse_request_params: {
        commerce_enable_local_pickup: true,
        commerce_enable_shipping: true,
        commerce_search_and_rp_available: true,
        commerce_search_and_rp_category_id: [],
        commerce_search_and_rp_condition: null,
        commerce_search_and_rp_ctime_days: null,
        filter_location_latitude: params.latitude,
        filter_location_longitude: params.longitude,
        filter_price_lower_bound: params.minPrice
          ? params.minPrice * 100
          : 0,
        filter_price_upper_bound: params.maxPrice
          ? params.maxPrice * 100
          : 214748364700,
        filter_radius_km: params.radiusKm,
      },
      custom_request_params: {
        browse_context: null,
        contextual_filters: [],
        referral_code: null,
        referral_ui_component: null,
        saved_search_strid: null,
        search_vertical: "C2C",
        seo_url: null,
        serp_landing_settings: {
          virtual_category_id: "",
        },
        surface: "SEARCH",
        virtual_contextual_filters: [],
      },
    },
    scale: 1,
    __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: true,
  };

  if (params.cursor) {
    variables.cursor = params.cursor;
  }

  if (params.category) {
    (
      variables.params as Record<string, unknown>
    ).browse_request_params = {
      ...(
        (variables.params as Record<string, unknown>)
          .browse_request_params as Record<string, unknown>
      ),
      commerce_search_and_rp_category_id: [params.category],
    };
  }

  return variables;
}

export function buildLocationSearchVariables(query: string) {
  return {
    params: {
      caller: "MARKETPLACE",
      page_category: ["CITY", "SUBCITY", "NEIGHBORHOOD"],
      query,
    },
  };
}
