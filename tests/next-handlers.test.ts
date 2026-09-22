import { describe, expect, it, vi } from "vitest"
import { createReviewsHandlers } from "../src/next/index.js"
import { ReviewsError } from "../src/errors.js"
import type { ReviewsClient } from "../src/client.js"
import type { ReviewsSnapshot, RefreshResult, PostbackResult, GoogleReview } from "../src/types.js"

type HandlePostbackInput = Parameters<ReviewsClient["handlePostback"]>[0]

function okPostbackResult(): PostbackResult {
  return {
    status: 200,
    body: { ok: true, taskId: "t1", locationKey: "loc1", decision: "applied", changes: { added: 0, updated: 0, unchanged: 0, nonDisplayable: 0, pendingRemoval: 0, removed: 0, collisions: 0, tombstonesPruned: 0 } },
  }
}

function fakeClient(overrides: Partial<ReviewsClient> = {}): ReviewsClient {
  return {
    readSnapshot: vi.fn(async () => null),
    getPublicReviews: vi.fn(() => []),
    runRefresh: vi.fn(async () => ({ ok: true, recovered: [], accepted: [], rejected: [], skipped: null }) satisfies RefreshResult),
    recoverReadyTasks: vi.fn(async () => []),
    handlePostback: vi.fn(async (_input: HandlePostbackInput) => okPostbackResult()),
    assertConfigured: vi.fn(),
    isCronAuthorized: vi.fn(() => true),
    reportError: vi.fn(),
    ...overrides,
  }
}

const SNAPSHOT: ReviewsSnapshot = {
  schemaVersion: 3,
  lastUpdated: "2026-09-21T00:00:00.000Z",
  reviews: [],
  metadata: {
    businessName: "Biz",
    averageRating: 4.5,
    totalReviews: 10,
    perLocation: {
      vineland: {
        count: 10,
        rating: 4.5,
        lastSyncMode: "incremental",
        lastResultAt: "2026-09-20T00:00:00.000Z",
        fullLeaseUntil: "2026-09-22T00:00:00.000Z",
        lastAcceptedTaskId: "secret-internal-id",
      },
    },
    pendingTasks: [],
  },
  processedTasks: [],
  tombstones: [],
}

describe("refreshReviewsGET", () => {
  it("returns 401 without calling runRefresh when not cron-authorized", async () => {
    const client = fakeClient({ isCronAuthorized: vi.fn(() => false) })
    const { refreshReviewsGET } = createReviewsHandlers(client)

    const response = await refreshReviewsGET(new Request("https://example.com/api/reviews/refresh"))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unauthorized" })
    expect(client.runRefresh).not.toHaveBeenCalled()
    expect(client.reportError).not.toHaveBeenCalled()
  })

  it("returns 200 with the RefreshResult when authorized", async () => {
    const result: RefreshResult = { ok: true, recovered: [], accepted: [{ taskId: "t1", locationKey: "vineland", mode: "incremental", depth: 10 }], rejected: [], skipped: null }
    const client = fakeClient({ runRefresh: vi.fn(async () => result) })
    const { refreshReviewsGET } = createReviewsHandlers(client)

    const response = await refreshReviewsGET(new Request("https://example.com/api/reviews/refresh"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(result)
    expect(client.runRefresh).toHaveBeenCalledWith({ forceFull: false })
    expect(client.reportError).not.toHaveBeenCalled()
  })

  it("passes forceFull:true when ?initial=true", async () => {
    const client = fakeClient()
    const { refreshReviewsGET } = createReviewsHandlers(client)

    await refreshReviewsGET(new Request("https://example.com/api/reviews/refresh?initial=true"))

    expect(client.runRefresh).toHaveBeenCalledWith({ forceFull: true })
  })

  it("returns 503 not_configured when runRefresh throws that ReviewsError, and reports it", async () => {
    const thrown = new ReviewsError("not_configured", "missing config", { missing: ["dataforseo.login"] })
    const client = fakeClient({
      runRefresh: vi.fn(async () => {
        throw thrown
      }),
    })
    const { refreshReviewsGET } = createReviewsHandlers(client)

    const response = await refreshReviewsGET(new Request("https://example.com/api/reviews/refresh"))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ ok: false, error: "not_configured", missing: ["dataforseo.login"] })
    expect(client.reportError).toHaveBeenCalledWith(thrown, { handler: "refreshReviewsGET", code: "not_configured" })
  })

  it.each(["dataforseo_billing", "dataforseo_request_failed", "task_rejected"])("returns 502 on %s, and reports it", async code => {
    const thrown = new ReviewsError(code, "upstream failure")
    const client = fakeClient({
      runRefresh: vi.fn(async () => {
        throw thrown
      }),
    })
    const { refreshReviewsGET } = createReviewsHandlers(client)

    const response = await refreshReviewsGET(new Request("https://example.com/api/reviews/refresh"))

    expect(response.status).toBe(502)
    expect(client.reportError).toHaveBeenCalledWith(thrown, { handler: "refreshReviewsGET", code })
  })

  it("returns 500 on unmapped errors, and reports it with code:\"unknown\"", async () => {
    const thrown = new Error("boom")
    const client = fakeClient({
      runRefresh: vi.fn(async () => {
        throw thrown
      }),
    })
    const { refreshReviewsGET } = createReviewsHandlers(client)

    const response = await refreshReviewsGET(new Request("https://example.com/api/reviews/refresh"))

    expect(response.status).toBe(500)
    expect(client.reportError).toHaveBeenCalledWith(thrown, { handler: "refreshReviewsGET", code: "unknown" })
  })
})

describe("dataforseoWebhookPOST", () => {
  it("forwards bytes, query, and contentLength to handlePostback and maps the result", async () => {
    const handlePostback = vi.fn(async (_input: HandlePostbackInput) => okPostbackResult())
    const client = fakeClient({ handlePostback })
    const { dataforseoWebhookPOST } = createReviewsHandlers(client)

    const payload = JSON.stringify({ tasks: [{}] })
    const request = new Request("https://example.com/api/reviews/webhook?secret=s3cret&id=t1", {
      method: "POST",
      headers: { "content-length": String(payload.length) },
      body: payload,
    })

    const response = await dataforseoWebhookPOST(request)

    expect(handlePostback).toHaveBeenCalledTimes(1)
    const call = handlePostback.mock.calls[0]![0]
    expect(new TextDecoder().decode(call.bytes)).toBe(payload)
    expect(call.query.get("secret")).toBe("s3cret")
    expect(call.query.get("id")).toBe("t1")
    expect(call.contentLength).toBe(payload.length)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, taskId: "t1" })
    expect(client.reportError).not.toHaveBeenCalled()
  })

  it("returns 500 and reports the error when handlePostback itself throws", async () => {
    const thrown = new Error("storage exploded")
    const handlePostback = vi.fn(async (_input: HandlePostbackInput) => {
      throw thrown
    })
    const client = fakeClient({ handlePostback })
    const { dataforseoWebhookPOST } = createReviewsHandlers(client)

    const request = new Request("https://example.com/api/reviews/webhook", { method: "POST", body: "{}" })
    const response = await dataforseoWebhookPOST(request)

    expect(response.status).toBe(500)
    expect(client.reportError).toHaveBeenCalledWith(thrown, { handler: "dataforseoWebhookPOST" })
  })

  it("maps a 401 unauthorized PostbackResult straight through", async () => {
    const handlePostback = vi.fn(async (_input: HandlePostbackInput): Promise<PostbackResult> => ({ status: 401, body: { ok: false, error: "unauthorized" } }))
    const client = fakeClient({ handlePostback })
    const { dataforseoWebhookPOST } = createReviewsHandlers(client)

    const request = new Request("https://example.com/api/reviews/webhook", { method: "POST", body: "{}" })
    const response = await dataforseoWebhookPOST(request)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unauthorized" })
  })

  it("passes contentLength as undefined when the header is absent", async () => {
    const handlePostback = vi.fn(async (_input: HandlePostbackInput) => okPostbackResult())
    const client = fakeClient({ handlePostback })
    const { dataforseoWebhookPOST } = createReviewsHandlers(client)

    const request = new Request("https://example.com/api/reviews/webhook", { method: "POST", body: "{}" })
    await dataforseoWebhookPOST(request)

    const call = handlePostback.mock.calls[0]![0]
    expect(call.contentLength).toBeUndefined()
  })

  it("returns 400 payload_too_large from Content-Length without ever reading the body", async () => {
    const handlePostback = vi.fn(async (_input: HandlePostbackInput) => okPostbackResult())
    const client = fakeClient({ handlePostback })
    const { dataforseoWebhookPOST } = createReviewsHandlers(client)

    const arrayBuffer = vi.fn(async () => {
      throw new Error("body must not be read when Content-Length exceeds the cap")
    })
    const oversizedRequest = {
      url: "https://example.com/api/reviews/webhook",
      headers: new Headers({ "content-length": String(11 * 1024 * 1024) }),
      arrayBuffer,
    } as unknown as Request

    const response = await dataforseoWebhookPOST(oversizedRequest)

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(handlePostback).not.toHaveBeenCalled()
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ ok: false, error: "payload_too_large" })
  })
})

describe("dataforseoWebhookGET", () => {
  it("returns a synchronous 200 health response", () => {
    const client = fakeClient()
    const { dataforseoWebhookGET } = createReviewsHandlers(client)

    const response = dataforseoWebhookGET()

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
  })

  it("returns the health body", async () => {
    const client = fakeClient()
    const { dataforseoWebhookGET } = createReviewsHandlers(client)

    const response = dataforseoWebhookGET()

    await expect(response.json()).resolves.toEqual({ ok: true, service: "reviews-webhook" })
  })
})

describe("reviewsApiGET", () => {
  it("returns empty defaults with no-store when there is no snapshot", async () => {
    const client = fakeClient({ readSnapshot: vi.fn(async () => null), getPublicReviews: vi.fn(() => []) })
    const { reviewsApiGET } = createReviewsHandlers(client)

    const response = await reviewsApiGET()

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({
      reviews: [],
      meta: { stale: false, lastUpdated: null, totalReviews: 0, averageRating: 0, perLocation: {} },
    })
  })

  it("maps snapshot metadata and strips internal perLocation fields", async () => {
    const client = fakeClient({
      readSnapshot: vi.fn(async () => SNAPSHOT),
      getPublicReviews: vi.fn(() => []),
    })
    const { reviewsApiGET } = createReviewsHandlers(client)

    const response = await reviewsApiGET()
    const json = (await response.json()) as { meta: { perLocation: Record<string, unknown> } }

    expect(json.meta).toMatchObject({ stale: false, lastUpdated: SNAPSHOT.lastUpdated, totalReviews: 10, averageRating: 4.5 })
    expect(json.meta.perLocation).toEqual({
      vineland: { count: 10, rating: 4.5, lastSyncMode: "incremental", lastResultAt: "2026-09-20T00:00:00.000Z" },
    })
    expect(json.meta.perLocation.vineland).not.toHaveProperty("fullLeaseUntil")
    expect(json.meta.perLocation.vineland).not.toHaveProperty("lastAcceptedTaskId")
  })

  it("projects each review to the public shape, dropping displayable and pendingRemovalAt", async () => {
    const review: GoogleReview = {
      id: "r1",
      locationKey: "vineland",
      authorName: "Jane",
      rating: 5,
      text: "Great!",
      publishedAt: "2026-09-20T00:00:00.000Z",
      relativeTime: "a week ago",
      reviewUrl: "https://example.com/review/r1",
      profileImageUrl: "https://example.com/avatar.png",
      ownerReply: { text: "Thanks!", publishedAt: "2026-09-21T00:00:00.000Z" },
      displayable: true,
      pendingRemovalAt: null,
    }
    const client = fakeClient({ readSnapshot: vi.fn(async () => SNAPSHOT), getPublicReviews: vi.fn(() => [review]) })
    const { reviewsApiGET } = createReviewsHandlers(client)

    const response = await reviewsApiGET()
    const json = (await response.json()) as { reviews: Array<Record<string, unknown>> }

    expect(json.reviews).toEqual([
      {
        id: "r1",
        locationKey: "vineland",
        authorName: "Jane",
        rating: 5,
        text: "Great!",
        publishedAt: "2026-09-20T00:00:00.000Z",
        relativeTime: "a week ago",
        reviewUrl: "https://example.com/review/r1",
        profileImageUrl: "https://example.com/avatar.png",
        ownerReply: { text: "Thanks!", publishedAt: "2026-09-21T00:00:00.000Z" },
      },
    ])
    expect(json.reviews[0]).not.toHaveProperty("displayable")
    expect(json.reviews[0]).not.toHaveProperty("pendingRemovalAt")
  })

  it("uses no-store by default", async () => {
    const client = fakeClient({ readSnapshot: vi.fn(async () => null), getPublicReviews: vi.fn(() => []) })
    const { reviewsApiGET } = createReviewsHandlers(client)

    const response = await reviewsApiGET()

    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("uses the configured reviewsApiCacheControl override", async () => {
    const client = fakeClient({ readSnapshot: vi.fn(async () => null), getPublicReviews: vi.fn(() => []) })
    const { reviewsApiGET } = createReviewsHandlers(client, { reviewsApiCacheControl: "public, max-age=60" })

    const response = await reviewsApiGET()

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60")
  })
})
