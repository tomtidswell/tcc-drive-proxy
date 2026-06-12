# TCC Drive Proxy

Cloudflare Worker that streams audio files from Google Drive for the TCC Repertoire web app.

## Purpose

This Worker proxies audio files from Google Drive, providing:

- **Edge caching**: Full files are cached at Cloudflare's edge (Cache API). The cache is per data centre and entries can be evicted, so Drive is still hit on cold starts, but repeat plays in a region are served from the edge
- **Range request support**: HTTP 206 partial content responses are served natively by the edge cache, so seeking works without the Worker buffering or slicing files
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
2. Worker matches the edge cache, forwarding the client's `Range` header. The Cache API serves the full file (200) or a byte range (206) natively from the stored full-file entry
3. On a miss, the Worker fetches the full file from Google Drive (rejecting HTML interstitials and files over 100 MB), stores it in the cache, then re-matches so ranges work on the first request too
4. CORS headers are added per-response (not cached) so one cache entry serves all origins

## Security

The Worker validates incoming requests against `ALLOWED_ORIGINS`:

- Checks the `Origin` header first
- Falls back to parsing the `Referer` header
- Returns 403 Forbidden if neither matches

This is best-effort hotlink protection, not authentication. `Origin` and `Referer` are only enforced by browsers, so it deters other websites from embedding the proxy but will not stop a scripted client that sets the headers itself. The audio being proxied is already publicly shared on Drive, so this is an accepted trade-off.

Note for the player app: an `<audio>` element only sends an `Origin` header when it has the `crossorigin` attribute. Without it, the proxy relies on the `Referer` fallback, which breaks silently if the app ever sets a strict referrer policy. Prefer `crossorigin="anonymous"` on the audio element.
