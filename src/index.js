const corsHeadersFor = (origin) => ({
  "Access-Control-Allow-Origin": origin || "null",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges",
  Vary: "Origin",
})

// Audio files are immutable: a given Drive id always returns the same bytes,
// and a new recording is uploaded as a new id. So cache hard at both layers.
const CACHE_CONTROL = "public, max-age=31536000, immutable"

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

// Parse a single "bytes=start-end" range against a known total size.
// Returns null when no Range header, "invalid" when unsatisfiable, or
// { start, end } (inclusive) otherwise.
const parseRange = (header, size) => {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return "invalid"
  const [, startRaw, endRaw] = match
  if (startRaw === "" && endRaw === "") return "invalid"

  let start
  let end
  if (startRaw === "") {
    // Suffix range: the final N bytes.
    const suffix = Number(endRaw)
    if (suffix === 0) return "invalid"
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === "" ? size - 1 : Number(endRaw)
  }

  if (start > end || start >= size) return "invalid"
  if (end >= size) end = size - 1
  return { start, end }
}

// Fetch the whole file from Drive and wrap it in a clean, cacheable 200.
// CORS is intentionally NOT stored, so a single cache entry is shared across
// every allowed origin; it is added per-response instead.
const fetchFullFromDrive = async (fileId) => {
  const driveUrl = `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}&export=download`

  const upstream = await fetch(driveUrl, { redirect: "follow" })
  if (!upstream.ok) {
    return { error: `Upstream returned ${upstream.status}`, status: 502 }
  }

  const contentType = upstream.headers.get("content-type") || "audio/mpeg"
  // Drive serves an HTML interstitial instead of the file when it cannot
  // hand the bytes over directly. Never cache that as audio.
  if (contentType.startsWith("text/html")) {
    return { error: "Upstream did not return a file", status: 502 }
  }

  const body = await upstream.arrayBuffer()
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

    // Edge-cache key: normalised to just the file id and the GET method, with
    // no Range or Origin, so every request for a file shares one cached copy.
    const cache = caches.default
    const cacheKeyUrl = new URL(request.url)
    cacheKeyUrl.search = `?id=${encodeURIComponent(fileId)}`
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" })

    let fullResponse = await cache.match(cacheKey)
    let cacheStatus = "HIT"

    if (!fullResponse) {
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

      fullResponse = result.response
      // Populate the edge cache without blocking this response.
      ctx.waitUntil(cache.put(cacheKey, fullResponse.clone()))
    }

    // fullResponse is always a complete 200 with the whole file. Serve a slice
    // if the client asked for a range, otherwise the whole thing.
    const totalLength = Number(fullResponse.headers.get("Content-Length"))
    const range = Number.isFinite(totalLength)
      ? parseRange(request.headers.get("Range"), totalLength)
      : null

    const headers = new Headers(fullResponse.headers)
    for (const [key, value] of Object.entries(corsHeadersFor(origin))) {
      headers.set(key, value)
    }
    headers.set("X-Cache", cacheStatus)

    if (range === "invalid") {
      headers.set("Content-Range", `bytes */${totalLength}`)
      return new Response(null, { status: 416, headers })
    }

    if (range) {
      const { start, end } = range
      headers.set("Content-Range", `bytes ${start}-${end}/${totalLength}`)
      headers.set("Content-Length", String(end - start + 1))
      if (request.method === "HEAD") {
        return new Response(null, { status: 206, headers })
      }
      const body = await fullResponse.arrayBuffer()
      return new Response(body.slice(start, end + 1), { status: 206, headers })
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers })
    }
    return new Response(fullResponse.body, { status: 200, headers })
  },
}
