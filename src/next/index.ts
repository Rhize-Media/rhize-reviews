import { ReviewsError } from "../errors.js"
import type { ReviewsClient } from "../client.js"
import type { GoogleReview, LocationSyncMetadata, ReviewSyncMode } from "../types.js"

const GATEWAY_ERROR_CODES = new Set(["dataforseo_billing", "dataforseo_request_failed", "task_rejected"])
const MAX_POSTBACK_BYTES = 10 * 1024 * 1024
const DEFAULT_REVIEWS_API_CACHE_CONTROL = "no-store"

class PayloadTooLargeError extends Error {}

/**
 * Reads a request body via its stream, aborting as soon as the running total
 * exceeds `maxBytes` — never buffering more than that, and never relying on
 * `Content-Length` alone (a header-less or lying request is still capped).
 */
async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await request.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new PayloadTooLargeError()
    return buf
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new PayloadTooLargeError()
      }
      chunks.push(value)
    }
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

interface PublicLocationMeta {
  count: number
  rating: number
  lastSyncMode: ReviewSyncMode | null
  lastResultAt?: string
}

interface PublicReview {
  id: string
  locationKey: string
  authorName: string
  rating: 1 | 2 | 3 | 4 | 5
  text: string
  publishedAt: string
  relativeTime?: string
  reviewUrl?: string
  profileImageUrl?: string
  ownerReply?: { text: string; publishedAt?: string }
}

export interface CreateReviewsHandlersOptions {
  /** `Cache-Control` header value for `reviewsApiGET`. Default: `"no-store"`. */
  reviewsApiCacheControl?: string
}

function toPublicLocationMeta(loc: LocationSyncMetadata): PublicLocationMeta {
  return {
    count: loc.count,
    rating: loc.rating,
    lastSyncMode: loc.lastSyncMode,
    ...(loc.lastResultAt !== undefined ? { lastResultAt: loc.lastResultAt } : {}),
  }
}

/** Strips internal fields (`displayable`, `pendingRemovalAt`) before a review is serialized to the public API. */
function toPublicReview(review: GoogleReview): PublicReview {
  return {
    id: review.id,
    locationKey: review.locationKey,
    authorName: review.authorName,
    rating: review.rating,
    text: review.text,
    publishedAt: review.publishedAt,
    ...(review.relativeTime !== undefined ? { relativeTime: review.relativeTime } : {}),
    ...(review.reviewUrl !== undefined ? { reviewUrl: review.reviewUrl } : {}),
    ...(review.profileImageUrl !== undefined ? { profileImageUrl: review.profileImageUrl } : {}),
    ...(review.ownerReply !== undefined ? { ownerReply: review.ownerReply } : {}),
  }
}

export function createReviewsHandlers(
  client: ReviewsClient,
  options: CreateReviewsHandlersOptions = {},
): {
  refreshReviewsGET(request: Request): Promise<Response>
  dataforseoWebhookPOST(request: Request): Promise<Response>
  dataforseoWebhookGET(): Response
  reviewsApiGET(): Promise<Response>
} {
  const reviewsApiCacheControl = options.reviewsApiCacheControl ?? DEFAULT_REVIEWS_API_CACHE_CONTROL
  async function refreshReviewsGET(request: Request): Promise<Response> {
    if (!client.isCronAuthorized(request.headers)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
    }

    const url = new URL(request.url)
    const forceFull = url.searchParams.get("initial") === "true"

    try {
      const result = await client.runRefresh({ forceFull })
      return Response.json(result, { status: 200 })
    } catch (error) {
      if (error instanceof ReviewsError) {
        if (error.code === "not_configured") {
          client.reportError(error, { handler: "refreshReviewsGET", code: error.code })
          return Response.json({ ok: false, error: "not_configured", missing: error.extra?.missing }, { status: 503 })
        }
        if (GATEWAY_ERROR_CODES.has(error.code)) {
          client.reportError(error, { handler: "refreshReviewsGET", code: error.code })
          return Response.json({ ok: false, error: error.code }, { status: 502 })
        }
        client.reportError(error, { handler: "refreshReviewsGET", code: error.code })
        return Response.json({ ok: false, error: "internal_error" }, { status: 500 })
      }
      client.reportError(error, { handler: "refreshReviewsGET", code: "unknown" })
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 })
    }
  }

  async function dataforseoWebhookPOST(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams

    // Authenticate before touching the body at all: an unauthorized caller
    // never causes us to read (or buffer) anything they sent.
    if (!client.isWebhookAuthorized(query)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
    }

    const contentLengthHeader = request.headers.get("content-length")
    let contentLength: number | undefined
    if (contentLengthHeader !== null) {
      const parsed = Number(contentLengthHeader)
      if (!Number.isInteger(parsed) || parsed < 0) {
        return Response.json({ ok: false, error: "invalid_content_length" }, { status: 400 })
      }
      contentLength = parsed
      if (contentLength > MAX_POSTBACK_BYTES) {
        return Response.json({ ok: false, error: "payload_too_large" }, { status: 400 })
      }
    }

    let bytes: Uint8Array
    try {
      bytes = await readBodyCapped(request, MAX_POSTBACK_BYTES)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return Response.json({ ok: false, error: "payload_too_large" }, { status: 400 })
      }
      client.reportError(error, { handler: "dataforseoWebhookPOST" })
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 })
    }

    try {
      const result = await client.handlePostback({
        bytes,
        query,
        ...(contentLength !== undefined ? { contentLength } : {}),
      })
      return Response.json(result.body, { status: result.status })
    } catch (error) {
      client.reportError(error, { handler: "dataforseoWebhookPOST" })
      return Response.json({ ok: false, error: "internal_error" }, { status: 500 })
    }
  }

  function dataforseoWebhookGET(): Response {
    return Response.json({ ok: true, service: "reviews-webhook" }, { status: 200 })
  }

  async function reviewsApiGET(): Promise<Response> {
    let snapshot: Awaited<ReturnType<ReviewsClient["readSnapshot"]>>
    try {
      snapshot = await client.readSnapshot()
    } catch {
      // storage.readForDisplay already reported this failure before throwing.
      return Response.json(
        { ok: false, error: "storage_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      )
    }
    const reviews = client.getPublicReviews(snapshot).map(toPublicReview)

    const meta = snapshot
      ? {
          stale: snapshot.readState?.stale ?? false,
          lastUpdated: snapshot.lastUpdated,
          totalReviews: snapshot.metadata.totalReviews,
          averageRating: snapshot.metadata.averageRating,
          perLocation: Object.fromEntries(
            Object.entries(snapshot.metadata.perLocation).map(([key, loc]) => [key, toPublicLocationMeta(loc)]),
          ),
        }
      : { stale: false, lastUpdated: null, totalReviews: 0, averageRating: 0, perLocation: {} }

    return Response.json({ reviews, meta }, { status: 200, headers: { "Cache-Control": reviewsApiCacheControl } })
  }

  return { refreshReviewsGET, dataforseoWebhookPOST, dataforseoWebhookGET, reviewsApiGET }
}
