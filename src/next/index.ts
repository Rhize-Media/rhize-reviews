import { ReviewsError } from "../errors.js"
import type { ReviewsClient } from "../client.js"
import type { LocationSyncMetadata, ReviewSyncMode } from "../types.js"

const GATEWAY_ERROR_CODES = new Set(["dataforseo_billing", "dataforseo_request_failed", "task_rejected"])

interface PublicLocationMeta {
  count: number
  rating: number
  lastSyncMode: ReviewSyncMode | null
  lastResultAt?: string
}

function toPublicLocationMeta(loc: LocationSyncMetadata): PublicLocationMeta {
  return {
    count: loc.count,
    rating: loc.rating,
    lastSyncMode: loc.lastSyncMode,
    ...(loc.lastResultAt !== undefined ? { lastResultAt: loc.lastResultAt } : {}),
  }
}

export function createReviewsHandlers(client: ReviewsClient): {
  refreshReviewsGET(request: Request): Promise<Response>
  dataforseoWebhookPOST(request: Request): Promise<Response>
  dataforseoWebhookGET(): Response
  reviewsApiGET(): Promise<Response>
} {
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
    const bytes = new Uint8Array(await request.arrayBuffer())
    const query = new URL(request.url).searchParams
    const contentLength = Number(request.headers.get("content-length")) || undefined

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
    const snapshot = await client.readSnapshot()
    const reviews = client.getPublicReviews(snapshot)

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

    return Response.json({ reviews, meta }, { status: 200, headers: { "Cache-Control": "no-store" } })
  }

  return { refreshReviewsGET, dataforseoWebhookPOST, dataforseoWebhookGET, reviewsApiGET }
}
