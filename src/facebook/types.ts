export interface FacebookCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
}

export interface FacebookSession {
  cookies: FacebookCookie[];
  cookieHeader: string;
  fbDtsg: string;
  lsd: string;
  jazoest: string;
  clientRevision: string;
  userId: string;
}

export interface MarketplaceListing {
  id: string;
  title: string;
  price: string;
  location: string;
  imageUrl: string;
  sellerId: string;
  sellerName: string;
  postedDate: string;
  url: string;
  isPending: boolean;
}

export interface MarketplaceListingDetail extends MarketplaceListing {
  description: string;
  images: string[];
  condition: string;
  seller: {
    id: string;
    name: string;
    profileUrl: string;
  };
}

export interface MessageThread {
  id: string;
  title: string;
  snippet: string;
  updatedAt: string;
  unreadCount: number;
  participantNames: string[];
}

export interface MarketplaceMessage {
  id: string;
  senderId: string;
  text: string;
  sentAt: string;
}

export interface SearchParams {
  query: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  minPrice?: number;
  maxPrice?: number;
  category?: string;
  limit: number;
  cursor?: string;
}

export interface SearchResult {
  listings: MarketplaceListing[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface SavedMonitor {
  id: string;
  name: string;
  params: Omit<SearchParams, "cursor">;
  seenIds: string[];
  createdAt: string;
  lastChecked: string | null;
}
