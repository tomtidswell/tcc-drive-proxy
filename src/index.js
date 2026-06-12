const corsHeadersFor = (origin) => {
  const headers = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges",
    Vary: "Origin",
  }
  if (origin) headers["Access-Control-Allow-Origin"] = origin
  return headers
}

// Audio files are immutable: a given Drive id always returns the same bytes,
// and a new recording is uploaded as a new id. So cache hard at both layers.
const CACHE_CONTROL = "public, max-age=31536000, immutable"

// The full file is buffered in memory once per cache miss, and the Worker
// isolate has a 128 MB limit, so refuse anything that could get close.
const MAX_FILE_BYTES = 100 * 1024 * 1024

const errorResponse = (message, status, origin) =>
  new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeadersFor(origin),
    },
  })

const parseAllowedOrigins = (raw) =>
  (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

const matchesAllowed = (origin, allowed) => {
  if (!origin) return null
  for (const entry of allowed) {
    if (entry === origin) return origin
    if (entry.startsWith("*.")) {
      const bare = entry.slice(2)
      try {
        const host = new URL(origin).host
        if (host === bare || host.endsWith("." + bare)) return origin
      } catch {
        // ignore parse error
      }
    }
  }
  return null
}

const resolveOrigin = (request, allowed) => {
  const headerOrigin = request.headers.get("Origin")
  const matched = matchesAllowed(headerOrigin, allowed)
  if (matched) return matched

  const referer = request.headers.get("Referer")
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin
      const matchedRef = matchesAllowed(refOrigin, allowed)
      if (matchedRef) return matchedRef
    } catch {
      // ignore parse error
    }
  }
  return null
}

// Fetch the whole file from Drive and wrap it in a clean, cacheable 200.
// CORS is intentionally NOT stored, so a single cache entry is shared across
// every allowed origin; it is added per-response instead. Content-Length is
// always set because the edge cache only serves Range requests (206) for
// entries that carry it.
const fetchFullFromDrive = async (fileId) => {
  const driveUrl = `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}&export=download`

  const upstream = await fetch(driveUrl, { redirect: "follow" })
  if (upstream.status === 404) return { error: "File not found", status: 404 }
  if (!upstream.ok) {
    return { error: `Upstream returned ${upstream.status}`, status: 502 }
  }

  const declaredLength = Number(upstream.headers.get("content-length"))
  if (declaredLength > MAX_FILE_BYTES) {
    return { error: "File too large to proxy", status: 502 }
  }

  const contentType = upstream.headers.get("content-type") || "audio/mpeg"
  // Drive serves an HTML interstitial instead of the file when it cannot
  // hand the bytes over directly. Never cache that as audio.
  if (contentType.startsWith("text/html")) {
    return { error: "Upstream did not return a file", status: 502 }
  }

  const body = await upstream.arrayBuffer()
  if (body.byteLength > MAX_FILE_BYTES) {
    return { error: "File too large to proxy", status: 502 }
  }

  const headers = new Headers()
  headers.set("Content-Type", contentType)
  headers.set("Cache-Control", CACHE_CONTROL)
  headers.set("Accept-Ranges", "bytes")
  headers.set("Content-Length", String(body.byteLength))
  for (const name of ["etag", "last-modified"]) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }

  return { response: new Response(body, { status: 200, headers }) }
}

export default {
  async fetch(request, env, ctx) {
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS)
    const origin = resolveOrigin(request, allowed)

    if (allowed.length > 0 && !origin) {
      return new Response("Forbidden", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeadersFor(origin),
      })
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse("Method not allowed", 405, origin)
    }

    const url = new URL(request.url)
    const fileId = url.searchParams.get("id")
    if (!fileId) return errorResponse("Missing file ID", 400, origin)

    // Edge-cache key: normalised to just the file id, with no Origin, so every
    // request for a file shares one cached full copy. The client's Range
    // header is forwarded on the match: the Cache API serves 206 slices
    // natively from stored entries that have a Content-Length, so the Worker
    // never parses ranges or buffers the file to slice it.
    const cache = caches.default
    const cacheKeyUrl = new URL(request.url)
    cacheKeyUrl.search = `?id=${encodeURIComponent(fileId)}`
    const matchHeaders = new Headers()
    const rangeHeader = request.headers.get("Range")
    if (rangeHeader) matchHeaders.set("Range", rangeHeader)
    const matchKey = new Request(cacheKeyUrl.toString(), {
      headers: matchHeaders,
    })

    let response = await cache.match(matchKey)
    let cacheStatus = "HIT"

    if (!response) {
      cacheStatus = "MISS"
      let result
      try {
        result = await fetchFullFromDrive(fileId)
      } catch (error) {
        return errorResponse(
          `Upstream fetch failed: ${error.message}`,
          502,
          origin,
        )
      }
      if (result.error)
        return errorResponse(result.error, result.status, origin)

      // Store first, then re-match, so a miss gets the same native Range
      // handling as a hit.
      try {
        await cache.put(
          new Request(cacheKeyUrl.toString()),
          result.response.clone(),
        )
        response = await cache.match(matchKey)
      } catch {
        // cache unavailable or entry rejected; fall through
      }
      // Fall back to the full file, ignoring Range (RFC 9110 permits this).
      if (!response) response = result.response
    }

    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(corsHeadersFor(origin))) {
      headers.set(key, value)
    }
    headers.set("X-Cache", cacheStatus)

    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers })
    }
    return new Response(response.body, { status: response.status, headers })
  },
}
