# Facebook Marketplace MCP Server

An MCP server that provides access to Facebook Marketplace via direct GraphQL API calls. No browser automation at runtime — speaks Facebook's internal protocol directly.

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
Search Marketplace by query, location, and filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search term |
| `latitude` | number | yes | Latitude of search center |
| `longitude` | number | yes | Longitude of search center |
| `radius_km` | number | no | Search radius (default: 50) |
| `min_price` | number | no | Min price in dollars |
| `max_price` | number | no | Max price in dollars |
| `category` | string | no | Category ID |
| `limit` | number | no | Max results (default: 20) |

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

The server self-rate-limits to 3 requests/minute with random jitter to avoid detection. This means searches take a few seconds.

## Limitations

- Hosted deployments require a manually refreshed authenticated Facebook cookie header
- **Facebook ToS** — automating Facebook violates their Terms of Service
- **Fragile** — `doc_id` values change on Facebook deploys
- **Rate limited** — aggressive use may trigger CAPTCHAs or account flags
- **No write operations** — search/read only, no messaging or listing creation
