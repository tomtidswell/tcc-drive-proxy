# TCC Drive Proxy

Cloudflare Worker that streams audio files from Google Drive for the TCC Repertoire web app.

## Purpose

This Worker proxies audio files from Google Drive, providing:

- **Edge caching**: Full files are cached at Cloudflare's edge (Cache API), so Google Drive is hit rarely
- **Range request support**: Serves HTTP 206 partial content responses for seeking
- **CORS headers**: Configurable allowed origins for cross-origin requests
- **Immutable caching**: Long-lived browser cache since Drive file IDs are immutable

## Setup

```bash
git clone <this-repo>
cd tcc-drive-proxy
pnpm install
```

## Development

```bash
pnpm run dev     # Start local dev server
pnpm run deploy  # Deploy to Cloudflare Workers
```

## Configuration

Allowed origins are configured in `wrangler.jsonc` under `vars.ALLOWED_ORIGINS`. This is a comma-separated list supporting:

- Exact origins: `https://example.com`
- Wildcard subdomains: `*.example.com`

Update this list to include your production domain after deployment.

## URL Pattern

The proxy serves files at:

```
https://drive-proxy.tomtidswell.workers.dev?id=<google-drive-file-id>
```

Where `<google-drive-file-id>` is the ID from a Google Drive sharing URL.

## Deployment

Authenticate with wrangler:

```bash
npx wrangler login
```

Then deploy:

```bash
pnpm run deploy
```

The Worker name and account are configured in `wrangler.jsonc`.

## How it works

1. Client requests a file by Drive ID
2. Worker checks if the file is in the edge cache
3. If not cached, fetches from Google Drive and caches the response
4. Serves the full file (200) or a byte range (206) to the client
5. CORS headers are added per-response (not cached) so one cache entry serves all origins

## Security

The Worker validates incoming requests against `ALLOWED_ORIGINS`:

- Checks the `Origin` header first
- Falls back to parsing the `Referer` header
- Returns 403 Forbidden if neither matches

This prevents unauthorized sites from using your proxy bandwidth.
