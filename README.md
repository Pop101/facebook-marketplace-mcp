# Facebook Marketplace MCP Server

An MCP server for Facebook Marketplace. Listing search and details use direct GraphQL requests; messaging uses the authenticated Facebook web client through Playwright and observes its GraphQL/Lightspeed responses.

## How It Works

Facebook's web client makes all Marketplace requests as `POST /api/graphql/` with a `doc_id` (query hash) and `variables`. This server replays those requests using your existing Facebook session cookies from Chrome.

**Think of it like [pypush](https://github.com/JJTech0130/pypush) for iMessage — direct protocol, no browser.**

## Prerequisites

- **Node.js** 20+
- Either **macOS** with Google Chrome and an active Facebook login, or an authenticated Facebook cookie header supplied through `FACEBOOK_COOKIE_HEADER`

## Installation

```bash
git clone <this-repo>
cd facebook-marketplace-mcp
npm install
npm run build
```

## Setup with Claude Code

```bash
claude mcp add facebook-marketplace -- node /path/to/facebook-marketplace-mcp/dist/index.js
```

Or add to your Claude Code config manually:

```json
{
  "mcpServers": {
    "facebook-marketplace": {
      "command": "node",
      "args": ["/path/to/facebook-marketplace-mcp/dist/index.js"],
      "env": {
        "CHROME_PROFILE": "Default"
      }
    }
  }
}
```

## Tools

### `search_listings`
Search Marketplace by query, location, and explicit delivery scope. The default is one page; pagination is exposed rather than hidden.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search term |
| `latitude` | number | yes | Latitude of search center |
| `longitude` | number | yes | Longitude of search center |
| `radius_km` | number | no | Requested radius (default: 50); distance is unverified |
| `min_price` | number | no | Min price in dollars |
| `max_price` | number | no | Max price in dollars |
| `category` | string | no | Category ID |
| `limit` | number | no | Requested page size, 1-100 (default: 20); Facebook may return fewer or more |
| `cursor` | string | no | Opaque `next_cursor` from the previous result, passed unchanged with the same query and filters |
| `max_pages` | number | no | Bounded automatic pagination, 1-5 pages (default: 1) |
| `delivery_method` | string | no | `local_pickup` (default), `shipping`, or `all` |

Results include both readable text and `structuredContent`: listing IDs, seller IDs,
prices, locations, available posting dates, raw delivery types, pending/sold status,
`pages_fetched`, `has_next_page`, `next_cursor`, `stop_reason`, and warnings. Missing
dates/delivery data are explicitly unknown, not inferred. Complete pages are never
truncated to `limit`: advancing the cursor after dropping extra results would lose
those listings. Duplicate IDs are removed within a call; callers should also dedupe
across continuations and query variants.

`stop_reason` is one of:
- `page_limit`: the page budget was reached; continue using `next_cursor`.
- `exhausted`: Facebook reports no more pages for **this query**, not a complete
  search of every relevant listing on Marketplace.
- `cursor_repeated`: pagination stopped because a cursor repeated; returned data
  are partial and no usable continuation is claimed.
- `page_error`: a later request failed; earlier results and the retry cursor are
  retained. Both this and `cursor_repeated` set MCP `isError: true`.

A malformed first response is a tool error, never "No listings found". Non-listing
feed units are counted and disclosed. Empty pages with advancing cursors are not
considered exhausted. The single-page default keeps normal calls short under the
existing 3-request/minute rate limit; multi-page calls may take several minutes.

**Search workflow:** use a broad name and specific model/name variants, follow
continuations to the desired budget, dedupe by listing ID, then inspect candidate
details/photos. State any coverage limits before recommending or ruling out options.

**Locality:** pickup versus shipping is sent to Facebook. In pickup mode, listings
with explicit shipping-only delivery are excluded. Unknown delivery remains labeled
unknown. The current search response supplies city names but not listing coordinates;
Facebook can broaden geography. Therefore distance is always marked **unverified**:
check the displayed location rather than claiming every result is within the radius.

### `get_listing`
Get full details for a specific listing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `listing_id` | string | yes | Marketplace listing ID |

### `get_listing_images`

Return a listing's photos as native MCP image content so vision-capable models can inspect them. This fetches only HTTPS Facebook CDN images, limits each image to 10 MB, and returns the first four photos by default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `listing_id` | string | yes | Marketplace listing ID |
| `image_numbers` | number[] | no | Specific 1-based photo numbers to return |
| `max_images` | number | no | Photos to return when `image_numbers` is omitted (default: 4; max: 10) |

### Messaging tools

These tools use the authenticated Facebook session to work with Messenger. `start_seller_thread` and `send_thread_message` send real messages; call them only after composing the final text.

| Tool | Purpose |
|------|---------|
| `check_messages` | List recently loaded Marketplace conversations, including unread counts and thread IDs. |
| `read_message_thread` | Read recent text messages in a thread. |
| `start_seller_thread` | Send first contact for a verified `listing_id` and `seller_id`; existing conversations must use `send_thread_message`. |
| `send_thread_message` | Send a message in an existing thread returned by `check_messages`. |

The server reports an error when Facebook does not explicitly confirm a send; it does not present an unconfirmed write as successful.

### `monitor_search`
Save a search as a monitor to track new listings over time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Monitor name |
| `query` | string | yes | Search term |
| `latitude` | number | yes | Search center lat |
| `longitude` | number | yes | Search center lng |
| `radius_km` | number | no | Radius (default: 50) |
| `min_price` | number | no | Min price |
| `max_price` | number | no | Max price |
| `category` | string | no | Category ID |
| `limit` | number | no | Requested page size (default: 24) |
| `max_pages` | number | no | Page budget, 1-5 (default: 1) |
| `delivery_method` | string | no | `local_pickup` (default), `shipping`, or `all` |

Monitor checks show continuation and partial-coverage warnings, including when no
new listings appeared in the scanned pages. Legacy monitors without a delivery
setting retain their previous `all` behavior. Successful pages can contribute seen
IDs even when a later page fails; last-checked time does not certify exhaustive
coverage.

### `check_monitors`
Check monitors for new listings since last check.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `monitor_name` | string | no | Check specific monitor, or omit for all |

### `list_monitors`
List all saved monitors.

### `delete_monitor`
Delete a saved monitor.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `CHROME_PROFILE` | `Default` | Chrome profile directory name (macOS fallback only) |
| `FACEBOOK_COOKIE_HEADER` | unset | Authenticated Facebook `Cookie` header. Required when hosted on Linux; must include `c_user` and be kept current. |
| `FACEBOOK_MARKETPLACE_DATA_DIR` | `~/.fb-marketplace` | Directory for persistent monitor data. |
| `MCP_API_KEY` | unset | Required by `npm run serve` to protect the loopback HTTP transport. |

## Hosted Endpoint

This repository is configured for the shared MCP gateway at:

```text
https://mcp.leibmann.org/marketplace
```

The gateway provides GitHub OAuth. The direct bearer-token route is available only to the local nginx configuration and is not intended for public use. On the host, populate `facebook-marketplace-mcp.env` with `FACEBOOK_COOKIE_HEADER` and `MCP_API_KEY`, then install and start `facebook-marketplace-mcp.service`.

The shared `mcp-front` configuration also needs a `marketplace` server entry pointing at `http://127.0.0.1:3103/mcp` and matching `/marketplace` nginx routes, mirroring the `cronometer` routes. Keep the gateway bearer token in `mcp-front`'s private configuration; it must never be added here.

For a host using the sibling projects in this workspace, add this private `mcp-front/config.json` entry:

```json
"marketplace": {
  "url": "http://127.0.0.1:3103/mcp",
  "transportType": "streamable-http",
  "headers": {
    "X-API-Key": "<private value matching MCP_API_KEY>"
  }
}
```

Then add exact and prefixed `/marketplace` nginx locations that follow the existing `/cronometer` pattern, changing only the service name and upstream port from `3102` to `3103`. Add `marketplace` to the two liveness server lists as well. These are host-specific changes and intentionally are not committed to this public repository.

## Updating GraphQL Queries

Facebook rotates their `doc_id` values on deploys. If searches stop working:

```bash
npm install -D playwright
npx playwright install chromium
npm run capture-queries
```

This opens a browser, navigates Marketplace, and captures current query IDs. Update `src/facebook/queries.ts` with the new values.

## Rate Limiting

Direct listing API requests are limited to 3 requests/minute with jitter. Browser messaging operations are serialized per server process, but the Facebook web client makes its own supporting network requests.

## Limitations

- Hosted deployments require a manually refreshed authenticated Facebook cookie header
- **Facebook ToS** — automating Facebook violates their Terms of Service
- **Fragile** — `doc_id` values change on Facebook deploys
- **Rate limited** — aggressive use may trigger CAPTCHAs or account flags
- **Outbound validation pending** — messaging write paths are implemented, but live delivery and never-contacted-seller flows have not passed end-to-end acceptance testing. No listing creation is supported.

## Messenger transport and validation

Messaging uses the authenticated Facebook web client through Playwright, not the
retired `/ajax/mercury/` endpoints. Facebook's client constructs its current
GraphQL and Lightspeed WebSocket requests; the MCP projects the server's
Lightspeed records into thread/message results. No fixed Messenger document ID
is guessed or replayed for sending.

Run `npx playwright install chromium` after installing dependencies. Messaging
uses the dedicated `.fb-profile/` maintained by `scripts/refresh-session.ts`;
`FACEBOOK_MESSENGER_PROFILE` can select a different authenticated dedicated
profile. The browser account must match the Marketplace session. The profile
must remain private and must not be committed. Browser operations are serialized
inside each server process. A profile occupied by the session refresher or
another process produces an explicit error, not an empty inbox.

`check_messages` reads the actual Marketplace folder, not just the generic
Messenger inbox. `read_message_thread` returns the recent messages loaded by the
web client, up to the requested limit; it does not promise a complete historical
export. Opening Messenger can mark the selected conversation read, so monitors
should compare message IDs/timestamps rather than relying only on unread counts.
Encrypted histories that are not available as plaintext fail explicitly.

For first contact, supply both `listing_id` and `seller_id` to
`start_seller_thread`. The seller is verified against the listing before any
message is entered. A listing that already has a conversation should use
`check_messages` followed by `send_thread_message` instead.

Sends are reported successful only after correlated server confirmation. A
transport/task acknowledgement alone is not delivery confirmation. An uncertain
send must not be automatically retried: inspect the thread first to avoid a
duplicate. New-contact and reply delivery need an explicitly authorized live
recipient for end-to-end acceptance testing; the audit did not send test
messages to sellers.

Run `npm test` for the offline regression suite. It uses synthetic fixtures and
no Facebook credentials, browser sessions, or real recipients. Live read-only
checks additionally verified Marketplace folder discovery and thread history.

GraphQL curl credentials and form bodies are passed through stdin, not process
arguments; subprocess errors and invalid GraphQL responses omit raw private
data. Environment files, browser profiles, HAR captures and key files are
excluded by `.gitignore`. This is prevention, not proof that a secret was never
exposed elsewhere.
