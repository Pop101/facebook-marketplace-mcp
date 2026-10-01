# Facebook Marketplace MCP Server — Context

## Architecture
Direct GraphQL API replay using session cookies (FACEBOOK_COOKIE_HEADER in
facebook-marketplace-mcp.env). All GraphQL/messaging POSTs go through
`bin/curl_chrome131` (curl-impersonate) because Facebook rejects plain
fetch/curl POST fingerprints with error 1357054 even when the request body is
byte-identical to the browser's. Page GETs (marketplace page, CDN images) are
fine with plain fetch.

## Session keep-alive (scripts/refresh-session.ts)
- Persistent headless Chromium profile in `.fb-profile/` keeps the Facebook
  session warm; rotated cookies are written back to the env file and the
  service restarts only on change. Runs every 2h via `fb-session-refresh.timer`.
- If the profile is logged out: it bootstraps from a pasted cookie header in
  the env file; credential login (fb-login.env) is the fallback but Facebook
  captcha-walls headless password logins from this IP (reCAPTCHA image
  challenge), so a fresh cookie paste is the reliable recovery.
- 2FA: FB_TOTP_SECRET in fb-login.env is supported if reachable.

## Key Files
- `src/index.ts` — MCP server entry point (stdio transport)
- `src/facebook/client.ts` — GraphQL HTTP client (curl-impersonate POSTs), session management, token extraction
- `src/facebook/auth.ts` — Chrome cookie extraction (SQLite + Keychain decrypt, macOS only)
- `src/facebook/queries.ts` — Known `doc_id` values for Marketplace GraphQL operations
- `src/facebook/parser.ts` — Response normalization for search results and listing details
- `src/tools/` — MCP tool handlers (search, listing, monitor)
- `src/storage/monitors.ts` — JSON file persistence for saved search monitors (~/.fb-marketplace/)
- `scripts/capture-queries.ts` — Playwright-based script to discover new GraphQL doc_ids
- `scripts/capture-pagination-headless.ts` — headless search-pagination capture (Linux server)
- `scripts/refresh-session.ts` — cookie keep-alive / re-login

## Fragility Points
- `doc_id` values change when Facebook deploys. To re-discover on this headless server:
  `FACEBOOK_COOKIE_HEADER=... npx tsx scripts/capture-pagination-headless.ts`
  (scroll-capture of the search pagination query), and for listing detail grab the
  `queryID` of `MarketplacePDPContainerQuery` / `MarketplacePDPC2CMediaViewerWithImagesQuery`
  from any `/marketplace/item/<id>/` page's Relay preloaders.
- Current doc_ids (Sep 2026): search `27212616558440397`, PDP `28471475289186074`, PDP media `10059604367394414`.
- TLS fingerprint: Facebook rejects non-browser fingerprints on POSTs. If
  curl-impersonate's Chrome target ages out, swap `bin/curl_chrome131` for a
  newer target from the same tarball (CURL_IMPERSONATE in client.ts).
- `fb_dtsg` token rotates per session (auto-refreshed on auth errors)
- Facebook DOM structure changes affect listing detail parsing
- Rate limiting: 3 req/min default to avoid detection

## Dependencies
- `@modelcontextprotocol/sdk` — MCP server framework
- `better-sqlite3` — Chrome cookie DB access
- `zod` — Tool schema validation
- `bin/curl_chrome131` — curl-impersonate static binary (lexiforest/curl-impersonate v2.2.3)

## Cookie Encryption (macOS Chrome)
- AES-128-CBC, PBKDF2 with SHA-1, salt="saltysalt", 1003 iterations
- Key from Keychain: `security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"`
- IV: 16 space characters, encrypted values prefixed with "v10"
