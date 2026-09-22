import { gzipSync } from "node:zlib"
import { describe, expect, it, vi } from "vitest"
import { createReviewsClient } from "../src/client.js"
import { createEmptySnapshot, reconcileReviews } from "../src/reconcile.js"
import * as storageModule from "../src/storage.js"
import { createStorage } from "../src/storage.js"
import type { ReconciliationBatch, ReconciliationDecision, ReviewLocation, ReviewsConfig, ReviewsSnapshot } from "../src/types.js"

// Every test in this file passes its own `deps.storage`, so wrapping the real
// `createStorage` in a spy is safe file-wide: it's only actually invoked by
// the one test below that checks what `createReviewsClient` passes it.
vi.mock("../src/storage.js", async () => {
  const actual = await vi.importActual<typeof import("../src/storage.js")>("../src/storage.js")
  return { ...actual, createStorage: vi.fn(actual.createStorage) }
})

type FakeStorage = ReturnType<typeof createStorage>

const NOW = "2026-09-21T00:00:00.000Z"

const SINGLE_LOCATION: ReviewLocation = {
  key: "vineland",
  displayName: "Vineland",
  identifier: { cid: "cid-vineland" },
  locationName: "New Jersey,United States",
}

const PLACE_ID_LOCATION: ReviewLocation = {
  key: "berlin",
  displayName: "Berlin",
  identifier: { placeId: "place-berlin" },
  locationName: "New Jersey,United States",
}

function fakeStorage(overrides: Partial<FakeStorage> = {}): FakeStorage {
  return { ...baseStorage(), ...overrides }
}

function baseStorage(snapshot: ReviewsSnapshot | null = null): FakeStorage {
  const current = snapshot

  function reconcileStub(batch: ReconciliationBatch) {
    const decision: ReconciliationDecision = "applied"
    return {
      result: {
        snapshot: current ?? createEmptySnapshot("Biz", [SINGLE_LOCATION], NOW),
        changes: { added: 1, updated: 0, unchanged: 0, nonDisplayable: 0, pendingRemoval: 0, removed: 0, collisions: 0, tombstonesPruned: 0 },
        decision,
        completeFullSnapshot: false,
        incompleteReason: null,
      },
      written: true,
    }
  }

  return {
    readFresh: vi.fn(async () => (current ? { snapshot: current, etag: '"e1"', source: "v3" as const } : null)),
    readForDisplay: vi.fn(async () => current),
    writeReconciled: vi.fn(async (batch: ReconciliationBatch) => reconcileStub(batch)),
    updateMetadata: vi.fn(async () => true),
    acquireCronLease: vi.fn(async () => "lease-owner-stub"),
    releaseCronLease: vi.fn(async (_owner: string) => {}),
    leaseFull: vi.fn(async (keys: string[]) => keys),
    clearFullLease: vi.fn(async () => {}),
    recordPendingTasks: vi.fn(async () => {}),
    removePendingTask: vi.fn(async () => {}),
    resetForTests: vi.fn(),
  } satisfies FakeStorage
}

/** A storage fake that runs the real `reconcileReviews` against an in-memory
 * snapshot, for tests that need genuine out-of-order / duplicate-task
 * behavior rather than a canned decision. */
function liveStorage(locations: ReviewLocation[]): FakeStorage {
  let snapshot: ReviewsSnapshot = createEmptySnapshot("Biz", locations, NOW)
  return {
    readFresh: vi.fn(async () => ({ snapshot, etag: '"e"', source: "v3" as const })),
    readForDisplay: vi.fn(async () => snapshot),
    writeReconciled: vi.fn(async (batch: ReconciliationBatch) => {
      const result = reconcileReviews(snapshot, batch, NOW)
      if (result.decision === "applied") snapshot = result.snapshot
      return { result, written: result.decision === "applied" }
    }),
    updateMetadata: vi.fn(async () => true),
    acquireCronLease: vi.fn(async () => "lease-owner-stub"),
    releaseCronLease: vi.fn(async (_owner: string) => {}),
    leaseFull: vi.fn(async (keys: string[]) => keys),
    clearFullLease: vi.fn(async () => {}),
    recordPendingTasks: vi.fn(async () => {}),
    removePendingTask: vi.fn(async () => {}),
    resetForTests: vi.fn(),
  } satisfies FakeStorage
}

function baseConfig(overrides: Partial<ReviewsConfig> = {}, locations: ReviewLocation[] = [SINGLE_LOCATION]): ReviewsConfig {
  return {
    businessName: "Biz",
    locations,
    dataforseo: { login: "user", password: "pass" },
    webhook: { secret: "s3cret", publicBaseUrl: "https://example.com" },
    cron: { secret: "cronsecret" },
    storage: { storeId: "store_test" },
    hooks: { reportError: vi.fn(), revalidate: vi.fn() },
    now: () => new Date(NOW),
    ...overrides,
  }
}

function bytesOf(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

function gzipBytesOf(payload: unknown): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(payload))))
}

// `cid` and `datetime` default to values that satisfy the default target
// (SINGLE_LOCATION "vineland", cid-configured) so tests not specifically
// about identity/datetime validation don't need to know about either.
// Pass `null` explicitly to omit the field (to test the "missing" case).
function taskEnvelope(
  overrides: Partial<{
    id: string
    status_code: number
    tag: string
    place_id: string
    cid: string | null
    items: unknown[]
    rating: number
    reviews_count: number
    resultCount: number
    datetime: string | null
  }> = {},
) {
  const result: Record<string, unknown> = {}
  if (overrides.place_id !== undefined) result.place_id = overrides.place_id
  if (overrides.cid !== undefined) {
    if (overrides.cid !== null) result.cid = overrides.cid
  } else {
    result.cid = "cid-vineland"
  }
  result.items = overrides.items ?? [
    { review_id: "r1", timestamp: NOW, rating: { value: 5 }, review_text: "Great!", profile_name: "Jane" },
  ]
  if (overrides.rating !== undefined) result.rating = { value: overrides.rating }
  if (overrides.reviews_count !== undefined) result.reviews_count = overrides.reviews_count
  if (overrides.datetime !== undefined) {
    if (overrides.datetime !== null) result.datetime = overrides.datetime
  } else {
    result.datetime = "2026-09-21 00:00:00 +00:00" // matches NOW
  }

  return {
    status_code: 20000,
    tasks: [
      {
        id: overrides.id ?? "task-1",
        status_code: overrides.status_code ?? 20000,
        data: overrides.tag !== undefined ? { tag: overrides.tag } : undefined,
        result: overrides.resultCount === 0 ? [] : overrides.resultCount === 2 ? [result, result] : [result],
      },
    ],
  }
}

describe("handlePostback: authorization", () => {
  it("rejects a missing secret with 401", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({ bytes: bytesOf(taskEnvelope()), query: new URLSearchParams() })
    expect(result.status).toBe(401)
  })

  it("rejects a wrong secret with 401", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "wrong" }),
    })
    expect(result.status).toBe(401)
  })

  it("rejects a duplicate secret query param with 401", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const query = new URLSearchParams()
    query.append("secret", "s3cret")
    query.append("secret", "s3cret")
    const result = await client.handlePostback({ bytes: bytesOf(taskEnvelope()), query })
    expect(result.status).toBe(401)
  })

  it("rejects a secret whose length differs from the configured secret with 401", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "short" }),
    })
    expect(result.status).toBe(401)
  })

  it("accepts the configured secret", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
  })
})

describe("handlePostback: body parsing", () => {
  it("rejects Content-Length above the cap with 400 before reading the body", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "s3cret" }),
      contentLength: 20 * 1024 * 1024,
    })
    expect(result.status).toBe(400)
    if (result.status === 400) expect(result.body.error).toBe("payload_too_large")
  })

  it("accepts a gzip body", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: gzipBytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
  })

  it("rejects a truncated gzip body with 400", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const gz = gzipBytesOf(taskEnvelope())
    const truncated = gz.subarray(0, gz.length - 4)
    const result = await client.handlePostback({ bytes: truncated, query: new URLSearchParams({ secret: "s3cret" }) })
    expect(result.status).toBe(400)
  })
})

describe("handlePostback: shape and location resolution", () => {
  it("rejects a payload with more than one result with 422", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ resultCount: 2, tag: "rhize-reviews:vineland:incremental:10" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
  })

  it("rejects task status_code !== 20000 with 422 and reports the error", async () => {
    const cfg = baseConfig()
    const client = createReviewsClient(cfg, { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ status_code: 40000 })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })

  it("rejects a ?id that does not equal tasks[0].id with 422", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ id: "task-1", tag: "rhize-reviews:vineland:incremental:10" })),
      query: new URLSearchParams({ secret: "s3cret", id: "task-2" }),
    })
    expect(result.status).toBe(422)
  })

  it("rejects conflicting ?tag and data.tag with 422", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10" })),
      query: new URLSearchParams({ secret: "s3cret", tag: "rhize-reviews:berlin:incremental:10" }),
    })
    expect(result.status).toBe(422)
  })

  it("rejects a place_id mismatch only when the resolved location is placeId-configured", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:berlin:incremental:10", place_id: "some-other-place" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
  })

  it("accepts a place_id present for a cid-configured location without comparing it", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10", place_id: "place-berlin" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
  })

  it("rejects a cid mismatch only when the resolved location is cid-configured", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10", cid: "some-other-cid" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("cid_mismatch")
  })

  it("accepts a matching cid for a cid-configured location", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10", cid: "cid-vineland" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
  })

  it("accepts a cid present for a placeId-configured location without comparing it", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:berlin:incremental:10", place_id: "place-berlin", cid: "cid-vineland" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
  })

  it("rejects a placeId-configured location with a missing place_id with 422 place_id_missing", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:berlin:incremental:10" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("place_id_missing")
  })

  it("rejects a cid-configured location with a missing cid with 422 cid_missing", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10", cid: null })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("cid_missing")
  })

  it("rejects ?tag and data.tag that agree on locationKey but disagree on depth with 422 tag_conflict", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ tag: "rhize-reviews:vineland:incremental:10" })),
      query: new URLSearchParams({ secret: "s3cret", tag: "rhize-reviews:vineland:incremental:20" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("tag_conflict")
  })

  it("falls back to the single configured location when no tag is present", async () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
    if (result.status === 200) expect(result.body.locationKey).toBe("vineland")
  })

  it("rejects a tagless postback for a multi-location config with 422", async () => {
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
  })
})

describe("handlePostback: storage and side effects", () => {
  it("returns 503 when storage.writeReconciled fails with a storage error", async () => {
    const storage = fakeStorage({
      writeReconciled: vi.fn(async (_batch: ReconciliationBatch) => {
        throw new (await import("../src/errors.js")).ReviewsError("storage_unavailable", "boom")
      }),
    })
    const cfg = baseConfig()
    const client = createReviewsClient(cfg, { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(503)
    if (result.status === 503) expect(result.body.error).toBe("storage_unavailable")
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })

  it("is idempotent for a duplicate task and still returns 200", async () => {
    const storage = fakeStorage({
      writeReconciled: vi.fn(async (_batch: ReconciliationBatch) => ({
        result: {
          snapshot: createEmptySnapshot("Biz", [SINGLE_LOCATION], NOW),
          changes: { added: 0, updated: 0, unchanged: 0, nonDisplayable: 0, pendingRemoval: 0, removed: 0, collisions: 0, tombstonesPruned: 0 },
          decision: "duplicate_task" as ReconciliationDecision,
          completeFullSnapshot: false,
          incompleteReason: null,
        },
        written: false,
      })),
    })
    const cfg = baseConfig()
    const client = createReviewsClient(cfg, { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
    if (result.status === 200) expect(result.body.decision).toBe("duplicate_task")
    expect(cfg.hooks.revalidate).not.toHaveBeenCalled()
  })

  it("returns 200 out_of_order with no metadata change for an out-of-order distinct task", async () => {
    const storage = fakeStorage({
      writeReconciled: vi.fn(async (_batch: ReconciliationBatch) => ({
        result: {
          snapshot: createEmptySnapshot("Biz", [SINGLE_LOCATION], NOW),
          changes: { added: 0, updated: 0, unchanged: 0, nonDisplayable: 0, pendingRemoval: 0, removed: 0, collisions: 0, tombstonesPruned: 0 },
          decision: "out_of_order" as ReconciliationDecision,
          completeFullSnapshot: false,
          incompleteReason: null,
        },
        written: false,
      })),
    })
    const cfg = baseConfig()
    const client = createReviewsClient(cfg, { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
    if (result.status === 200) expect(result.body.decision).toBe("out_of_order")
    expect(storage.updateMetadata).not.toHaveBeenCalled()
    expect(cfg.hooks.revalidate).not.toHaveBeenCalled()
  })

  it("still returns 200 when hooks.revalidate throws, and reports the error", async () => {
    const cfg = baseConfig({ hooks: { reportError: vi.fn(), revalidate: vi.fn(async () => { throw new Error("revalidate boom") }) } })
    const client = createReviewsClient(cfg, { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })
})

describe("isCronAuthorized", () => {
  it("accepts a matching Authorization: Bearer header", () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    expect(client.isCronAuthorized(new Headers({ authorization: "Bearer cronsecret" }))).toBe(true)
  })

  it("rejects a missing header", () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    expect(client.isCronAuthorized(new Headers())).toBe(false)
  })

  it("rejects the secret supplied as a query param instead of the header", () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    expect(client.isCronAuthorized(new Headers({ authorization: "cronsecret" }))).toBe(false)
  })
})

describe("reportError", () => {
  it("delegates to config.hooks.reportError", () => {
    const reportError = vi.fn()
    const config = baseConfig({ hooks: { reportError, revalidate: vi.fn() } })
    const client = createReviewsClient(config, { storage: fakeStorage() })

    const error = new Error("boom")
    client.reportError(error, { handler: "refreshReviewsGET" })

    expect(reportError).toHaveBeenCalledWith(error, { handler: "refreshReviewsGET" })
  })
})

describe("recoverReadyTasks", () => {
  it("processes one ready task and skips one already recorded as processed", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) {
        return Response.json({
          tasks: [
            {
              result: [
                { id: "ready-1", tag: "rhize-reviews:vineland:incremental:10" },
                { id: "already-processed", tag: "rhize-reviews:vineland:incremental:10" },
              ],
            },
          ],
        })
      }
      if (url.includes("task_get")) {
        return Response.json(taskEnvelope({ id: "ready-1", tag: "rhize-reviews:vineland:incremental:10" }))
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    const snapshot: ReviewsSnapshot = {
      ...createEmptySnapshot("Biz", [SINGLE_LOCATION], NOW),
      processedTasks: [{ taskId: "already-processed", locationKey: "vineland", mode: "incremental", resultAt: NOW, processedAt: NOW }],
    }
    const storage = fakeStorage()
    storage.readFresh = vi.fn(async () => ({ snapshot, etag: '"e"', source: "v3" as const }))

    const client = createReviewsClient(baseConfig(), { storage, fetchImpl })
    const recovered = await client.recoverReadyTasks()

    expect(recovered).toEqual([{ taskId: "ready-1", locationKey: "vineland", decision: "applied" }])
    expect(fetchImpl).toHaveBeenCalledTimes(2) // tasks_ready + one task_get (not two)
  })

  it("skips a ready task tagged for another tenant's location without calling task_get", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) {
        return Response.json({ tasks: [{ result: [{ id: "foreign-1", tag: "rhize-reviews:other:incremental:10" }] }] })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage, fetchImpl })

    const recovered = await client.recoverReadyTasks()

    expect(recovered).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1) // tasks_ready only, no task_get
  })

  it("skips a ready task with no tag without calling task_get", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [{ id: "untagged-1" }] }] })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig({}, [SINGLE_LOCATION, PLACE_ID_LOCATION]), { storage, fetchImpl })

    const recovered = await client.recoverReadyTasks()

    expect(recovered).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("does not touch the cron lease", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [] }] })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage, fetchImpl })

    await client.recoverReadyTasks()

    expect(storage.acquireCronLease).not.toHaveBeenCalled()
    expect(storage.releaseCronLease).not.toHaveBeenCalled()
  })
})

describe("runRefresh", () => {
  function refreshDeps() {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [] }] })
      if (url.includes("task_post")) {
        return Response.json({
          status_code: 20000,
          tasks: [{ id: "new-task-1", status_code: 20100, status_message: "Task Created." }],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    return fetchImpl
  }

  it("returns unauthorized-shaped rejection when not configured (throws not_configured)", async () => {
    const cfg = baseConfig({ cron: { secret: "" } })
    const client = createReviewsClient(cfg, { storage: fakeStorage(), fetchImpl: refreshDeps() })
    await expect(client.runRefresh()).rejects.toMatchObject({ code: "not_configured" })
  })

  it("a releaseCronLease failure is swallowed (reported, not thrown) and never masks the run's own result", async () => {
    const storage = fakeStorage({
      releaseCronLease: vi.fn(async () => {
        throw new Error("release boom")
      }),
    })
    const cfg = baseConfig()
    const client = createReviewsClient(cfg, { storage, fetchImpl: refreshDeps() })

    const result = await client.runRefresh()

    expect(result.ok).toBe(true)
    expect(cfg.hooks.reportError).toHaveBeenCalledWith(expect.any(Error), { operation: "releaseCronLease" })
  })

  it("a releaseCronLease failure is swallowed and never masks a thrown error from the run itself", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [] }] })
      if (url.includes("task_post")) return new Response("server error", { status: 500 })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const storage = fakeStorage({
      releaseCronLease: vi.fn(async () => {
        throw new Error("release boom")
      }),
    })
    const client = createReviewsClient(baseConfig(), { storage, fetchImpl })

    // The task_post transport failure must propagate — not the releaseCronLease failure.
    await expect(client.runRefresh()).rejects.toMatchObject({ code: "dataforseo_request_failed" })
  })

  it("returns skipped: cron_lease_held when the lease is already held", async () => {
    const storage = fakeStorage({ acquireCronLease: vi.fn(async () => null) })
    const client = createReviewsClient(baseConfig(), { storage, fetchImpl: refreshDeps() })
    const result = await client.runRefresh()
    expect(result.skipped).toBe("cron_lease_held")
    expect(storage.releaseCronLease).not.toHaveBeenCalled()
  })

  it("recovers a ready task exactly once through the postback pipeline", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [{ id: "ready-1", tag: "rhize-reviews:vineland:incremental:10" }] }] })
      if (url.includes("task_get")) return Response.json(taskEnvelope({ id: "ready-1", tag: "rhize-reviews:vineland:incremental:10" }))
      if (url.includes("task_post")) return Response.json({ status_code: 20000, tasks: [] })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage, fetchImpl })
    const result = await client.runRefresh()
    expect(result.recovered).toEqual([{ taskId: "ready-1", locationKey: "vineland", decision: "applied" }])
    expect(storage.releaseCronLease).toHaveBeenCalled()
  })

  it("retains accepted task ids and clears the rejected location's full lease on partial acceptance", async () => {
    const berlin = { ...PLACE_ID_LOCATION }
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [] }] })
      if (url.includes("task_post")) {
        return Response.json({
          status_code: 20000,
          tasks: [
            { id: "t-vineland", status_code: 20100, status_message: "Task Created." },
            { status_code: 40501, status_message: "Insufficient funds" },
          ],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const cfg = baseConfig({}, [SINGLE_LOCATION, berlin])
    const storage = fakeStorage()
    const client = createReviewsClient(cfg, { storage, fetchImpl })
    const result = await client.runRefresh()
    expect(result.accepted.map(a => a.taskId)).toContain("t-vineland")
    expect(result.rejected.length).toBe(1)
    expect(storage.recordPendingTasks).toHaveBeenCalledWith(result.accepted)
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })

  it("reports a stale snapshot warning when lastUpdated is older than staleAfterDays", async () => {
    const oldSnapshot: ReviewsSnapshot = {
      ...createEmptySnapshot("Biz", [SINGLE_LOCATION], "2026-01-01T00:00:00.000Z"),
      lastUpdated: "2026-01-01T00:00:00.000Z",
    }
    const storage = fakeStorage()
    storage.readFresh = vi.fn(async () => ({ snapshot: oldSnapshot, etag: '"e"', source: "v3" as const }))
    const cfg = baseConfig({ sync: { staleAfterDays: 14 } })
    const client = createReviewsClient(cfg, { storage, fetchImpl: refreshDeps() })
    await client.runRefresh()
    expect(cfg.hooks.reportError).toHaveBeenCalledWith(expect.objectContaining({ code: "snapshot_stale" }), expect.anything())
  })

  it("requests a full task when forceFull is set and full reconciliation is enabled", async () => {
    let posted: unknown
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [] }] })
      if (url.includes("task_post")) {
        posted = JSON.parse(init!.body as string)
        return Response.json({ status_code: 20000, tasks: [{ id: "full-1", status_code: 20100, status_message: "Task Created." }] })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const cfg = baseConfig({ sync: { fullReconciliationEnabled: true } })
    const storage = fakeStorage()
    const client = createReviewsClient(cfg, { storage, fetchImpl })
    await client.runRefresh({ forceFull: true })
    expect(storage.leaseFull).toHaveBeenCalled()
    expect(posted).toEqual([expect.objectContaining({ tag: expect.stringContaining(":full:") })])
  })
})

describe("readSnapshot / getPublicReviews", () => {
  it("readSnapshot delegates to storage.readForDisplay", async () => {
    const snapshot = createEmptySnapshot("Biz", [SINGLE_LOCATION], NOW)
    const storage = fakeStorage()
    storage.readForDisplay = vi.fn(async () => snapshot)
    const client = createReviewsClient(baseConfig(), { storage })
    await expect(client.readSnapshot()).resolves.toBe(snapshot)
  })

  it("getPublicReviews returns [] for a null snapshot", () => {
    const client = createReviewsClient(baseConfig(), { storage: fakeStorage() })
    expect(client.getPublicReviews(null)).toEqual([])
  })
})

describe("assertConfigured", () => {
  it("throws not_configured listing every missing field", () => {
    const cfg = baseConfig({
      dataforseo: { login: "", password: "" },
      webhook: { secret: "", publicBaseUrl: "" },
      cron: { secret: "" },
      storage: {},
    })
    const client = createReviewsClient(cfg, { storage: fakeStorage() })
    expect(() => client.assertConfigured()).toThrow(expect.objectContaining({ code: "not_configured" }))
    try {
      client.assertConfigured()
    } catch (error) {
      const extra = (error as { extra?: { missing?: string[] } }).extra
      expect(extra?.missing).toEqual(
        expect.arrayContaining(["dataforseo.login", "dataforseo.password", "webhook.secret", "cron.secret", "storage.storeId", "webhook.publicBaseUrl"]),
      )
    }
  })

  it("requires publicBaseUrl to be https unless localhost", () => {
    const cfg = baseConfig({ webhook: { secret: "s", publicBaseUrl: "http://example.com" } })
    const client = createReviewsClient(cfg, { storage: fakeStorage() })
    expect(() => client.assertConfigured()).toThrow()
  })

  it("allows an http localhost publicBaseUrl", () => {
    const cfg = baseConfig({ webhook: { secret: "s", publicBaseUrl: "http://localhost:3000" } })
    const client = createReviewsClient(cfg, { storage: fakeStorage() })
    expect(() => client.assertConfigured()).not.toThrow()
  })
})

describe("fix round 1: resultAt uses the provider's DataForSEO datetime", () => {
  it("uses result.datetime (space+offset format) as resultAt instead of now()", async () => {
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ datetime: "2026-09-21 11:00:34 +00:00" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
    const batchArg = vi.mocked(storage.writeReconciled).mock.calls[0]![0] as ReconciliationBatch
    expect(batchArg.resultAt).toBe(new Date("2026-09-21T11:00:34+00:00").toISOString())
  })

  it("rejects with 422 result_datetime_invalid, and reports it, when result.datetime is absent", async () => {
    const storage = fakeStorage()
    const cfg = baseConfig()
    const client = createReviewsClient(cfg, { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ datetime: null })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("result_datetime_invalid")
    expect(cfg.hooks.reportError).toHaveBeenCalled()
    expect(storage.writeReconciled).not.toHaveBeenCalled()
  })

  it("rejects with 422 result_datetime_invalid for a timezone-free datetime value", async () => {
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ datetime: "2026-09-21 11:00:34" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("result_datetime_invalid")
  })

  it("rejects an impossible calendar date (2026-02-30) instead of letting Date.parse normalize it", async () => {
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ datetime: "2026-02-30 10:00:00 +00:00" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("result_datetime_invalid")
  })

  it("accepts Feb 29 on a leap year", async () => {
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ datetime: "2024-02-29 10:00:00 +00:00" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(200)
    const batchArg = vi.mocked(storage.writeReconciled).mock.calls[0]![0] as ReconciliationBatch
    expect(batchArg.resultAt).toBe(new Date("2024-02-29T10:00:00Z").toISOString())
  })

  it("rejects a timezone offset hour outside 0-14", async () => {
    const storage = fakeStorage()
    const client = createReviewsClient(baseConfig(), { storage })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ datetime: "2026-09-21 11:00:34 +99:00" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(result.status).toBe(422)
    if (result.status === 422) expect(result.body.error).toBe("result_datetime_invalid")
  })

  it("marks a recovered task with an older DataForSEO datetime than an already-applied newer postback as out_of_order", async () => {
    const storage = liveStorage([SINGLE_LOCATION])
    const client = createReviewsClient(baseConfig(), { storage })

    const newer = await client.handlePostback({
      bytes: bytesOf(taskEnvelope({ id: "task-newer", datetime: "2026-09-21 12:00:00 +00:00" })),
      query: new URLSearchParams({ secret: "s3cret" }),
    })
    expect(newer.status).toBe(200)
    if (newer.status === 200) expect(newer.body.decision).toBe("applied")

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [{ id: "task-older", tag: "rhize-reviews:vineland:incremental:10" }] }] })
      if (url.includes("task_get")) {
        return Response.json(taskEnvelope({ id: "task-older", datetime: "2026-09-21 11:00:00 +00:00" }))
      }
      if (url.includes("task_post")) return Response.json({ status_code: 20000, tasks: [] })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    const cfg = baseConfig()
    const client2 = createReviewsClient(cfg, { storage, fetchImpl })
    const result = await client2.runRefresh()

    expect(result.recovered).toEqual([{ taskId: "task-older", locationKey: "vineland", decision: "out_of_order" }])
  })
})

describe("fix round 1: full lease released when createReviewTasks throws", () => {
  it("clears the leased full locations when task_post fails after leaseFull succeeded", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [] }] })
      if (url.includes("task_post")) return new Response("server error", { status: 500 })
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    const cfg = baseConfig({ sync: { fullReconciliationEnabled: true } })
    const storage = fakeStorage()
    const client = createReviewsClient(cfg, { storage, fetchImpl })

    await expect(client.runRefresh({ forceFull: true })).rejects.toThrow()

    expect(storage.leaseFull).toHaveBeenCalled()
    expect(storage.clearFullLease).toHaveBeenCalledWith(["vineland"])
    expect(storage.releaseCronLease).toHaveBeenCalled()
  })
})

describe("fix round 1: empty configured secrets never authorize", () => {
  it("isCronAuthorized rejects a matching empty Bearer header when cron.secret is empty", () => {
    const cfg = baseConfig({ cron: { secret: "" } })
    const client = createReviewsClient(cfg, { storage: fakeStorage() })
    // A real `Headers` instance trims trailing whitespace off the value, which would
    // make "Bearer " arrive as "Bearer" and fail on length alone — masking the bug.
    // Use a minimal Headers-shaped stub so the exact "Bearer " (empty secret) value
    // actually reaches the comparison.
    const fakeHeaders = {
      get: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer " : null),
    } as unknown as Headers
    expect(client.isCronAuthorized(fakeHeaders)).toBe(false)
  })

  it("handlePostback rejects a matching empty ?secret= when webhook.secret is empty", async () => {
    const cfg = baseConfig({ webhook: { secret: "", publicBaseUrl: "https://example.com" } })
    const client = createReviewsClient(cfg, { storage: fakeStorage() })
    const result = await client.handlePostback({
      bytes: bytesOf(taskEnvelope()),
      query: new URLSearchParams({ secret: "" }),
    })
    expect(result.status).toBe(401)
  })
})

describe("0.1.1: legacyLocationKeys plumbed into storage.createStorage", () => {
  it("passes deps.legacyLocationKeys through to createStorage when the client creates storage itself", () => {
    const legacyLocationKeys = { Vineland: "vineland" }
    createReviewsClient(baseConfig(), { legacyLocationKeys })

    expect(vi.mocked(storageModule.createStorage)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ legacyLocationKeys }),
    )
  })

  it("does not call createStorage at all when deps.storage is already provided", () => {
    vi.mocked(storageModule.createStorage).mockClear()
    createReviewsClient(baseConfig(), { storage: fakeStorage(), legacyLocationKeys: { Vineland: "vineland" } })

    expect(storageModule.createStorage).not.toHaveBeenCalled()
  })
})
