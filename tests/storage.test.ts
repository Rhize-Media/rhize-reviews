import { beforeEach, describe, expect, it, vi } from "vitest"
import { BlobPreconditionFailedError } from "@vercel/blob"
import { ReviewsError } from "../src/errors.js"
import { createStorage } from "../src/storage.js"
import { createEmptySnapshot } from "../src/reconcile.js"
import type { ReconciliationBatch, ReviewLocation, ReviewsConfig, ReviewsSnapshot } from "../src/types.js"

const NOW = "2026-08-28T16:30:00.000Z"

const LOCATIONS: ReviewLocation[] = [
  { key: "vineland", displayName: "Vineland", identifier: { cid: "1" }, locationName: "Vineland" },
  { key: "berlin", displayName: "Berlin", identifier: { cid: "2" }, locationName: "Berlin" },
]

function batch(id: string, locationKey = "vineland"): ReconciliationBatch {
  return {
    taskId: `task-${locationKey}-${id}`,
    locationKey,
    mode: "incremental",
    resultAt: NOW,
    requestedDepth: 10,
    itemsCount: 1,
    reviewsCount: 1,
    invalidItemsCount: 0,
    reviews: [
      {
        id,
        locationKey,
        authorName: "Reviewer",
        rating: 5,
        text: `Review ${id}`,
        publishedAt: NOW,
        displayable: true,
      },
    ],
    removalEnabled: false,
  }
}

function blobResult(snapshot: unknown, etag: string) {
  return {
    statusCode: 200,
    stream: new Response(JSON.stringify(snapshot)).body,
    headers: new Headers(),
    blob: {
      etag,
      url: "https://blob.example/reviews.v3.json",
      downloadUrl: "https://blob.example/reviews.v3.json?download=1",
      pathname: "google-reviews/reviews.v3.json",
      contentType: "application/json",
      contentDisposition: "inline",
      cacheControl: "public, max-age=60",
      size: 1,
      uploadedAt: new Date(NOW),
    },
  }
}

function baseConfig(
  overrides: Partial<Omit<ReviewsConfig["storage"], "storeId">> & { storeId?: string | null } = {},
): ReviewsConfig {
  const { storeId, ...rest } = overrides
  const storage: ReviewsConfig["storage"] =
    storeId === null ? { ...rest } : { storeId: storeId ?? "store_test", ...rest }
  return {
    businessName: "Biz",
    locations: LOCATIONS,
    dataforseo: { login: "u", password: "p" },
    webhook: { secret: "s", publicBaseUrl: "https://example.com" },
    cron: { secret: "c" },
    storage,
    hooks: { reportError: vi.fn(), revalidate: vi.fn() },
    now: () => new Date(NOW),
  }
}

function makeDeps() {
  return {
    get: vi.fn(),
    put: vi.fn(),
    getOidcToken: vi.fn().mockResolvedValue("test-oidc"),
  }
}

describe("createStorage: readFresh", () => {
  it("reads the v3 pathname with private access, cache bypass, and identity encoding", async () => {
    const deps = makeDeps()
    const empty = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValueOnce(blobResult(empty, '"etag-1"'))
    const storage = createStorage(baseConfig(), deps)

    const fresh = await storage.readFresh()

    expect(deps.get).toHaveBeenCalledWith("google-reviews/reviews.v3.json", {
      storeId: "store_test",
      oidcToken: "test-oidc",
      access: "private",
      useCache: false,
      headers: { "accept-encoding": "identity" },
    })
    expect(fresh).toEqual({ snapshot: empty, etag: '"etag-1"', source: "v3" })
  })

  it("falls back to the legacy pathname, migrates in memory, and never writes it back", async () => {
    const deps = makeDeps()
    deps.get.mockImplementation(async (pathname: string) => {
      if (pathname === "google-reviews/reviews.v3.json") return null
      if (pathname === "google-reviews/reviews.json") {
        return blobResult(
          {
            schemaVersion: 2,
            lastUpdated: NOW,
            reviews: [
              {
                id: "legacy-1",
                location: "Vineland",
                content: "Legacy review",
                date: NOW,
                author: "Legacy Author",
                rating: "5",
                displayable: true,
              },
            ],
            metadata: { businessName: "Biz", locationBreakdown: { Vineland: 1 } },
            processedTasks: [],
            tombstones: [],
          },
          '"legacy-etag"',
        )
      }
      throw new Error(`unexpected pathname ${pathname}`)
    })
    const storage = createStorage(baseConfig(), deps)

    const fresh = await storage.readFresh()

    expect(fresh?.source).toBe("legacy")
    expect(fresh?.etag).toBeNull()
    expect(fresh?.snapshot.reviews[0]).toMatchObject({ id: "legacy-1", locationKey: "Vineland" })
    expect(deps.put).not.toHaveBeenCalled()
  })

  it("plumbs deps.legacyLocationKeys into migration, mapping the legacy display name to the configured key", async () => {
    const deps = makeDeps()
    deps.get.mockImplementation(async (pathname: string) => {
      if (pathname === "google-reviews/reviews.v3.json") return null
      if (pathname === "google-reviews/reviews.json") {
        return blobResult(
          {
            schemaVersion: 2,
            lastUpdated: NOW,
            reviews: [
              {
                id: "legacy-1",
                location: "Vineland",
                content: "Legacy review",
                date: NOW,
                author: "Legacy Author",
                rating: "5",
                displayable: true,
              },
            ],
            metadata: { businessName: "Biz", locationBreakdown: { Vineland: 1 } },
            processedTasks: [],
            tombstones: [],
          },
          '"legacy-etag"',
        )
      }
      throw new Error(`unexpected pathname ${pathname}`)
    })
    const storage = createStorage(baseConfig(), { ...deps, legacyLocationKeys: { Vineland: "vineland" } })

    const fresh = await storage.readFresh()

    expect(fresh?.snapshot.reviews[0]).toMatchObject({ id: "legacy-1", locationKey: "vineland" })
  })

  it("returns null when neither pathname has a blob", async () => {
    const deps = makeDeps()
    deps.get.mockResolvedValue(null)
    const storage = createStorage(baseConfig(), deps)

    await expect(storage.readFresh()).resolves.toBeNull()
  })

  it("throws storage_unsupported_schema for an unknown schemaVersion, never falling back to legacy", async () => {
    const deps = makeDeps()
    const future = { ...createEmptySnapshot("Biz", LOCATIONS, NOW), schemaVersion: 4 }
    deps.get.mockResolvedValueOnce(blobResult(future, '"etag-9"'))
    const storage = createStorage(baseConfig(), deps)

    await expect(storage.readFresh()).rejects.toMatchObject({ code: "storage_unsupported_schema" })
    expect(deps.get).toHaveBeenCalledTimes(1) // never reads the legacy pathname
  })
})

describe("createStorage: reserved pathname", () => {
  it("throws storage_invalid_pathname when storage.pathname is the reserved legacy pathname", () => {
    expect(() => createStorage(baseConfig({ pathname: "google-reviews/reviews.json" }))).toThrow(
      expect.objectContaining({ code: "storage_invalid_pathname" }),
    )
  })
})

describe("createStorage: unsupported schema fails writes/reads closed", () => {
  it("writeReconciled fails closed (storage_unavailable) against a v4 blob, and never writes", async () => {
    const deps = makeDeps()
    const future = { ...createEmptySnapshot("Biz", LOCATIONS, NOW), schemaVersion: 4 }
    deps.get.mockResolvedValue(blobResult(future, '"etag-9"'))
    const storage = createStorage(baseConfig(), deps)

    await expect(storage.writeReconciled(batch("r1"))).rejects.toMatchObject({ code: "storage_unavailable" })
    expect(deps.put).not.toHaveBeenCalled()
  })

  it("readForDisplay falls back to a stale copy of the last-known snapshot when one exists", async () => {
    const deps = makeDeps()
    const good = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValueOnce(blobResult(good, '"etag-1"'))
    const cfg = baseConfig()
    const storage = createStorage(cfg, deps)
    await storage.readForDisplay()

    const future = { ...good, schemaVersion: 4 }
    deps.get.mockResolvedValue(blobResult(future, '"etag-9"'))
    const displayed = await storage.readForDisplay()

    expect(displayed).toMatchObject({ schemaVersion: 3, readState: { stale: true, reason: "storage_unavailable" } })
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })

  it("readForDisplay throws when there is no last-known snapshot to fall back to", async () => {
    const deps = makeDeps()
    const future = { ...createEmptySnapshot("Biz", LOCATIONS, NOW), schemaVersion: 4 }
    deps.get.mockResolvedValue(blobResult(future, '"etag-9"'))
    const cfg = baseConfig()
    const storage = createStorage(cfg, deps)

    await expect(storage.readForDisplay()).rejects.toMatchObject({ code: "storage_unsupported_schema" })
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })
})

describe("createStorage: auth resolution", () => {
  it("throws storage_not_configured when no storeId and the RW-token flag is off, even with the env var set", async () => {
    const deps = makeDeps()
    process.env.BLOB_READ_WRITE_TOKEN = "legacy-token"
    try {
      const storage = createStorage(baseConfig({ storeId: null }), deps)
      await expect(storage.readFresh()).rejects.toThrow(ReviewsError)
      await expect(storage.readFresh()).rejects.toMatchObject({ code: "storage_not_configured" })
      expect(deps.get).not.toHaveBeenCalled()
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN
    }
  })

  it("accepts BLOB_READ_WRITE_TOKEN when allowReadWriteToken is true", async () => {
    const deps = makeDeps()
    deps.get.mockResolvedValue(null)
    process.env.BLOB_READ_WRITE_TOKEN = "legacy-token"
    try {
      const cfg = baseConfig({ storeId: null, allowReadWriteToken: true })
      const storage = createStorage(cfg, deps)
      await storage.readFresh()
      expect(deps.get).toHaveBeenCalledWith(
        "google-reviews/reviews.v3.json",
        expect.objectContaining({ token: "legacy-token" }),
      )
      expect(deps.get).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ storeId: expect.anything() }))
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN
    }
  })
})

describe("createStorage: readForDisplay", () => {
  it("returns the fresh snapshot on success", async () => {
    const deps = makeDeps()
    const empty = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValueOnce(blobResult(empty, '"etag-1"'))
    const storage = createStorage(baseConfig(), deps)

    await expect(storage.readForDisplay()).resolves.toEqual(empty)
  })

  it("serves the last-known snapshot with readState.stale on failure", async () => {
    const deps = makeDeps()
    const empty = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValueOnce(blobResult(empty, '"etag-1"'))
    const cfg = baseConfig()
    const storage = createStorage(cfg, deps)
    await storage.readForDisplay()

    deps.get.mockRejectedValueOnce(new Error("transient failure"))
    const degraded = await storage.readForDisplay()

    expect(degraded).toMatchObject({ readState: { stale: true } })
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })

  it("throws (after reporting) when there is no last-known snapshot and the read fails", async () => {
    const deps = makeDeps()
    deps.get.mockRejectedValue(new Error("down"))
    const cfg = baseConfig()
    const storage = createStorage(cfg, deps)

    await expect(storage.readForDisplay()).rejects.toThrow("down")
    expect(cfg.hooks.reportError).toHaveBeenCalled()
  })

  it("single-flights concurrent calls", async () => {
    const deps = makeDeps()
    const empty = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValue(blobResult(empty, '"etag-1"'))
    const storage = createStorage(baseConfig(), deps)

    await Promise.all([storage.readForDisplay(), storage.readForDisplay(), storage.readForDisplay()])

    expect(deps.get).toHaveBeenCalledTimes(1)
  })
})

describe("createStorage: writeReconciled", () => {
  it("commits with the matching ETag and allowOverwrite:true against an existing v3 snapshot", async () => {
    const deps = makeDeps()
    const empty = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValue(blobResult(empty, '"etag-1"'))
    deps.put.mockResolvedValue({ etag: '"etag-2"' })
    const storage = createStorage(baseConfig(), deps)

    const outcome = await storage.writeReconciled(batch("new"))

    expect(outcome.written).toBe(true)
    expect(outcome.result.decision).toBe("applied")
    expect(deps.put).toHaveBeenCalledWith(
      "google-reviews/reviews.v3.json",
      expect.any(String),
      expect.objectContaining({
        storeId: "store_test",
        oidcToken: "test-oidc",
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        ifMatch: '"etag-1"',
      }),
    )
    const [, body] = deps.put.mock.calls[0]!
    expect(JSON.parse(body as string)).not.toHaveProperty("readState")
  })

  it("uses allowOverwrite:false and no ifMatch for the first v3 write on an empty store", async () => {
    const deps = makeDeps()
    deps.get.mockResolvedValue(null)
    deps.put.mockResolvedValue({ etag: '"etag-1"' })
    const storage = createStorage(baseConfig(), deps)

    await storage.writeReconciled(batch("new"))

    expect(deps.put).toHaveBeenCalledWith(
      "google-reviews/reviews.v3.json",
      expect.any(String),
      expect.objectContaining({ allowOverwrite: false }),
    )
    const options = deps.put.mock.calls[0]![2] as Record<string, unknown>
    expect(options).not.toHaveProperty("ifMatch")
  })

  it("does not write on a duplicate task delivery", async () => {
    const deps = makeDeps()
    const current = createEmptySnapshot("Biz", LOCATIONS, NOW)
    current.processedTasks.push({
      taskId: "task-vineland-dup",
      locationKey: "vineland",
      mode: "incremental",
      resultAt: NOW,
      processedAt: NOW,
    })
    deps.get.mockResolvedValue(blobResult(current, '"etag-1"'))
    const storage = createStorage(baseConfig(), deps)

    const outcome = await storage.writeReconciled(batch("dup"))

    expect(outcome.written).toBe(false)
    expect(outcome.result.decision).toBe("duplicate_task")
    expect(deps.put).not.toHaveBeenCalled()
  })

  it("re-reads and re-reconciles on a CAS conflict, preserving a concurrent writer", async () => {
    const deps = makeDeps()
    const original = createEmptySnapshot("Biz", LOCATIONS, NOW)
    const concurrent = {
      ...original,
      reviews: [
        {
          id: "berlin-1",
          locationKey: "berlin",
          authorName: "Other",
          rating: 5 as const,
          text: "Berlin review",
          publishedAt: NOW,
          displayable: true,
        },
      ],
    }
    deps.get.mockResolvedValueOnce(blobResult(original, '"etag-1"')).mockResolvedValueOnce(blobResult(concurrent, '"etag-2"'))
    deps.put.mockRejectedValueOnce(new BlobPreconditionFailedError()).mockResolvedValueOnce({ etag: '"etag-3"' })
    const storage = createStorage(baseConfig(), deps)

    const outcome = await storage.writeReconciled(batch("vineland-1"))

    expect(outcome.written).toBe(true)
    const [, body] = deps.put.mock.calls[1]!
    const stored = JSON.parse(body as string) as ReviewsSnapshot
    expect(stored.reviews.map(r => r.id).sort()).toEqual(["berlin-1", "vineland-1"])
  })

  it("exhausts retries and throws storage_conflict_exhausted after 5 attempts", async () => {
    const deps = makeDeps()
    const current = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockImplementation(async () => blobResult(current, '"etag-1"'))
    deps.put.mockRejectedValue(new BlobPreconditionFailedError())
    const storage = createStorage(baseConfig(), deps)

    await expect(storage.writeReconciled(batch("new"))).rejects.toMatchObject({
      code: "storage_conflict_exhausted",
    })
    expect(deps.put).toHaveBeenCalledTimes(5)
  })

  it("wraps a non-conflict put failure as storage_unavailable", async () => {
    const deps = makeDeps()
    const current = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValue(blobResult(current, '"etag-1"'))
    deps.put.mockRejectedValue(new Error("service down"))
    const storage = createStorage(baseConfig(), deps)

    await expect(storage.writeReconciled(batch("new"))).rejects.toMatchObject({
      code: "storage_unavailable",
    })
    expect(deps.put).toHaveBeenCalledTimes(1)
  })

  it("converges five concurrent postbacks for distinct locations without lost updates", async () => {
    const deps = makeDeps()
    let stored: ReviewsSnapshot = createEmptySnapshot("Biz", [...LOCATIONS, { key: "glassboro", displayName: "Glassboro", identifier: { cid: "3" }, locationName: "Glassboro" }, { key: "marmora", displayName: "Marmora", identifier: { cid: "4" }, locationName: "Marmora" }, { key: "wildwood", displayName: "Wildwood", identifier: { cid: "5" }, locationName: "Wildwood" }], NOW)
    let version = 1
    deps.get.mockImplementation(async () => blobResult(stored, `"etag-${version}"`))
    deps.put.mockImplementation(async (_p: string, body: string, opts: { ifMatch?: string }) => {
      if (opts.ifMatch !== `"etag-${version}"`) throw new BlobPreconditionFailedError()
      stored = JSON.parse(body) as ReviewsSnapshot
      version += 1
      return { etag: `"etag-${version}"` }
    })
    const cfg = baseConfig()
    cfg.locations = [...LOCATIONS, { key: "glassboro", displayName: "Glassboro", identifier: { cid: "3" }, locationName: "Glassboro" }, { key: "marmora", displayName: "Marmora", identifier: { cid: "4" }, locationName: "Marmora" }, { key: "wildwood", displayName: "Wildwood", identifier: { cid: "5" }, locationName: "Wildwood" }]
    const storage = createStorage(cfg, deps)

    const keys = ["vineland", "berlin", "glassboro", "marmora", "wildwood"]
    await Promise.all(keys.map(key => storage.writeReconciled(batch(key, key))))

    expect(stored.reviews.map(r => r.locationKey).sort()).toEqual([...keys].sort())
  })

  it("lets exactly one of two writers racing on an empty store create, and the other re-reads and merges", async () => {
    const deps = makeDeps()
    let stored: ReviewsSnapshot | null = null
    let version = 0
    deps.get.mockImplementation(async () => (stored ? blobResult(stored, `"etag-${version}"`) : null))
    deps.put.mockImplementation(async (_p: string, body: string, opts: { ifMatch?: string; allowOverwrite?: boolean }) => {
      if (!stored) {
        // First create: succeeds only once (empty store, allowOverwrite:false).
        stored = JSON.parse(body) as ReviewsSnapshot
        version = 1
        return { etag: `"etag-${version}"` }
      }
      if (opts.ifMatch !== `"etag-${version}"`) throw new BlobPreconditionFailedError()
      stored = JSON.parse(body) as ReviewsSnapshot
      version += 1
      return { etag: `"etag-${version}"` }
    })
    const storage = createStorage(baseConfig(), deps)

    const [a, b] = await Promise.all([storage.writeReconciled(batch("vineland-1")), storage.writeReconciled(batch("berlin-1", "berlin"))])

    expect(a.written).toBe(true)
    expect(b.written).toBe(true)
    expect(stored!.reviews.map(r => r.id).sort()).toEqual(["berlin-1", "vineland-1"])
  })
})

describe("createStorage: updateMetadata", () => {
  it("writes the mutated snapshot and returns true", async () => {
    const deps = makeDeps()
    const current = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValue(blobResult(current, '"etag-1"'))
    deps.put.mockResolvedValue({ etag: '"etag-2"' })
    const storage = createStorage(baseConfig(), deps)

    const wrote = await storage.updateMetadata(snapshot => ({
      ...snapshot,
      metadata: { ...snapshot.metadata, cronLeaseUntil: "2026-08-28T16:40:00.000Z" },
    }))

    expect(wrote).toBe(true)
    expect(deps.put).toHaveBeenCalledTimes(1)
  })

  it("returns false and never writes when the mutator returns null", async () => {
    const deps = makeDeps()
    const current = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValue(blobResult(current, '"etag-1"'))
    const storage = createStorage(baseConfig(), deps)

    const wrote = await storage.updateMetadata(() => null)

    expect(wrote).toBe(false)
    expect(deps.put).not.toHaveBeenCalled()
  })

  it("re-reads and retries on a CAS conflict", async () => {
    const deps = makeDeps()
    const current = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValueOnce(blobResult(current, '"etag-1"')).mockResolvedValueOnce(blobResult(current, '"etag-2"'))
    deps.put.mockRejectedValueOnce(new BlobPreconditionFailedError()).mockResolvedValueOnce({ etag: '"etag-3"' })
    const storage = createStorage(baseConfig(), deps)

    const wrote = await storage.updateMetadata(snapshot => ({
      ...snapshot,
      metadata: { ...snapshot.metadata, cronLeaseUntil: "2026-08-28T16:40:00.000Z" },
    }))

    expect(wrote).toBe(true)
    expect(deps.put).toHaveBeenCalledTimes(2)
  })
})

describe("createStorage: leases", () => {
  it("acquires a cron lease, blocks a second acquire before expiry, and allows it after release", async () => {
    const deps = makeDeps()
    let stored = createEmptySnapshot("Biz", LOCATIONS, NOW)
    let version = 1
    deps.get.mockImplementation(async () => blobResult(stored, `"etag-${version}"`))
    deps.put.mockImplementation(async (_p: string, body: string, opts: { ifMatch?: string }) => {
      if (opts.ifMatch !== `"etag-${version}"`) throw new BlobPreconditionFailedError()
      stored = JSON.parse(body) as ReviewsSnapshot
      version += 1
      return { etag: `"etag-${version}"` }
    })
    const storage = createStorage(baseConfig(), deps)

    const first = await storage.acquireCronLease(new Date(NOW), 10 * 60 * 1000)
    expect(typeof first).toBe("string")

    const second = await storage.acquireCronLease(new Date(NOW), 10 * 60 * 1000)
    expect(second).toBeNull()

    await storage.releaseCronLease(first!)
    const third = await storage.acquireCronLease(new Date(NOW), 10 * 60 * 1000)
    expect(typeof third).toBe("string")
    expect(third).not.toBe(first)
  })

  it("an expired lease can be taken over by a new owner, and the original owner's release does not clear it", async () => {
    const deps = makeDeps()
    let stored = createEmptySnapshot("Biz", LOCATIONS, NOW)
    let version = 1
    deps.get.mockImplementation(async () => blobResult(stored, `"etag-${version}"`))
    deps.put.mockImplementation(async (_p: string, body: string, opts: { ifMatch?: string }) => {
      if (opts.ifMatch !== `"etag-${version}"`) throw new BlobPreconditionFailedError()
      stored = JSON.parse(body) as ReviewsSnapshot
      version += 1
      return { etag: `"etag-${version}"` }
    })
    const storage = createStorage(baseConfig(), deps)
    const start = new Date(NOW)

    const ownerA = await storage.acquireCronLease(start, 10 * 60 * 1000)
    expect(ownerA).not.toBeNull()

    const later = new Date(start.getTime() + 11 * 60 * 1000)
    const ownerB = await storage.acquireCronLease(later, 10 * 60 * 1000)
    expect(ownerB).not.toBeNull()
    expect(ownerB).not.toBe(ownerA)

    // A's (stale) release must not clear B's lease.
    await storage.releaseCronLease(ownerA!)
    const blockedForA = await storage.acquireCronLease(later, 10 * 60 * 1000)
    expect(blockedForA).toBeNull()

    // B's own release does clear it.
    await storage.releaseCronLease(ownerB!)
    const reacquired = await storage.acquireCronLease(later, 10 * 60 * 1000)
    expect(reacquired).not.toBeNull()
  })

  it("acquires a cron lease again once the previous one has expired", async () => {
    const deps = makeDeps()
    let stored = createEmptySnapshot("Biz", LOCATIONS, NOW)
    let version = 1
    deps.get.mockImplementation(async () => blobResult(stored, `"etag-${version}"`))
    deps.put.mockImplementation(async (_p: string, body: string, opts: { ifMatch?: string }) => {
      if (opts.ifMatch !== `"etag-${version}"`) throw new BlobPreconditionFailedError()
      stored = JSON.parse(body) as ReviewsSnapshot
      version += 1
      return { etag: `"etag-${version}"` }
    })
    const storage = createStorage(baseConfig(), deps)
    const start = new Date(NOW)

    await storage.acquireCronLease(start, 10 * 60 * 1000)
    const later = new Date(start.getTime() + 11 * 60 * 1000)
    const acquiredAfterExpiry = await storage.acquireCronLease(later, 10 * 60 * 1000)

    expect(typeof acquiredAfterExpiry).toBe("string")
  })

  it("leaseFull returns only the keys it successfully leased, and skips already-leased keys", async () => {
    const deps = makeDeps()
    let stored = createEmptySnapshot("Biz", LOCATIONS, NOW)
    let version = 1
    deps.get.mockImplementation(async () => blobResult(stored, `"etag-${version}"`))
    deps.put.mockImplementation(async (_p: string, body: string, opts: { ifMatch?: string }) => {
      if (opts.ifMatch !== `"etag-${version}"`) throw new BlobPreconditionFailedError()
      stored = JSON.parse(body) as ReviewsSnapshot
      version += 1
      return { etag: `"etag-${version}"` }
    })
    const storage = createStorage(baseConfig(), deps)

    const leased = await storage.leaseFull(["vineland", "berlin"], new Date(NOW), 6 * 60 * 60 * 1000)
    expect(leased.sort()).toEqual(["berlin", "vineland"])

    const secondAttempt = await storage.leaseFull(["vineland"], new Date(NOW), 6 * 60 * 60 * 1000)
    expect(secondAttempt).toEqual([])

    await storage.clearFullLease(["vineland"])
    const afterClear = await storage.leaseFull(["vineland"], new Date(NOW), 6 * 60 * 60 * 1000)
    expect(afterClear).toEqual(["vineland"])
  })

  it("records and removes pending tasks", async () => {
    const deps = makeDeps()
    let stored = createEmptySnapshot("Biz", LOCATIONS, NOW)
    let version = 1
    deps.get.mockImplementation(async () => blobResult(stored, `"etag-${version}"`))
    deps.put.mockImplementation(async (_p: string, body: string, opts: { ifMatch?: string }) => {
      if (opts.ifMatch !== `"etag-${version}"`) throw new BlobPreconditionFailedError()
      stored = JSON.parse(body) as ReviewsSnapshot
      version += 1
      return { etag: `"etag-${version}"` }
    })
    const storage = createStorage(baseConfig(), deps)

    await storage.recordPendingTasks([{ taskId: "t1", locationKey: "vineland", mode: "incremental", depth: 10 }])
    expect(stored.metadata.pendingTasks).toHaveLength(1)
    expect(stored.metadata.pendingTasks[0]).toMatchObject({ taskId: "t1", locationKey: "vineland" })

    await storage.removePendingTask("t1")
    expect(stored.metadata.pendingTasks).toHaveLength(0)
  })
})

describe("createStorage: resetForTests", () => {
  it("clears the last-known snapshot cache used by readForDisplay's degraded fallback", async () => {
    const deps = makeDeps()
    const empty = createEmptySnapshot("Biz", LOCATIONS, NOW)
    deps.get.mockResolvedValueOnce(blobResult(empty, '"etag-1"'))
    const storage = createStorage(baseConfig(), deps)
    await storage.readForDisplay()

    storage.resetForTests()

    deps.get.mockRejectedValueOnce(new Error("down"))
    await expect(storage.readForDisplay()).rejects.toThrow("down")
  })
})
