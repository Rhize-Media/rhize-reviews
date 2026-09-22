import { BlobError, BlobPreconditionFailedError, get, put } from "@vercel/blob"
import { getVercelOidcToken } from "@vercel/oidc"
import { ReviewsError } from "./errors.js"
import { migrateSnapshot } from "./migrate.js"
import { createEmptySnapshot, reconcileReviews } from "./reconcile.js"
import type { ReconciliationBatch, ReconciliationResult, ReviewSyncMode, ReviewsConfig, ReviewsSnapshot } from "./types.js"
import { isRecord } from "./util.js"

const LEGACY_PATHNAME = "google-reviews/reviews.json"
const MAX_CAS_ATTEMPTS = 5
const BASE_RETRY_DELAY_MS = 25

type BlobGet = typeof get
type BlobPut = typeof put

export interface StorageDeps {
  get?: BlobGet
  put?: BlobPut
  getOidcToken?: () => Promise<string>
}

type FreshRead = { snapshot: ReviewsSnapshot; etag: string | null; source: "v3" | "legacy" | "none" }

type Auth = { storeId: string; oidcToken: string } | { token: string }


function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isConflict(error: unknown): boolean {
  if (error instanceof BlobPreconditionFailedError) return true
  if (error instanceof BlobError) return /precondition|etag|412/i.test(error.message)
  return false
}

export function createStorage(cfg: ReviewsConfig, deps: StorageDeps = {}) {
  const getFn = deps.get ?? get
  const putFn = deps.put ?? put
  const getOidcTokenFn = deps.getOidcToken ?? getVercelOidcToken
  const v3Pathname = cfg.storage.pathname ?? "google-reviews/reviews.v3.json"

  let lastKnownSnapshot: ReviewsSnapshot | null = null
  let pendingDisplayRead: Promise<ReviewsSnapshot | null> | null = null

  function nowIso(): string {
    return (cfg.now?.() ?? new Date()).toISOString()
  }

  async function resolveAuth(): Promise<Auth> {
    if (cfg.storage.storeId) {
      const oidcToken = await getOidcTokenFn()
      return { storeId: cfg.storage.storeId, oidcToken }
    }
    if (cfg.storage.allowReadWriteToken && process.env.BLOB_READ_WRITE_TOKEN) {
      return { token: process.env.BLOB_READ_WRITE_TOKEN }
    }
    throw new ReviewsError("storage_not_configured", "Reviews Blob storage is not configured")
  }

  function migrateContext() {
    return { businessName: cfg.businessName, locations: cfg.locations, now: nowIso() }
  }

  function parseRaw(raw: unknown): ReviewsSnapshot | null {
    if (isRecord(raw) && typeof raw.schemaVersion === "number" && raw.schemaVersion > 3) {
      cfg.hooks.reportError(new Error("Unknown reviews snapshot schemaVersion"), {
        schemaVersion: raw.schemaVersion,
      })
      return raw as unknown as ReviewsSnapshot
    }
    return migrateSnapshot(raw, migrateContext())
  }

  async function readAt(pathname: string, auth: Auth): Promise<{ raw: unknown; etag: string } | null> {
    const result = await getFn(pathname, {
      ...auth,
      access: "private",
      useCache: false,
      headers: { "accept-encoding": "identity" },
    })
    if (!result) return null
    const raw = await new Response(result.stream).json()
    return { raw, etag: result.blob.etag }
  }

  async function readFresh(): Promise<FreshRead | null> {
    const auth = await resolveAuth()

    const v3 = await readAt(v3Pathname, auth)
    if (v3) {
      const snapshot = parseRaw(v3.raw)
      if (snapshot) return { snapshot, etag: v3.etag, source: "v3" }
    }

    const legacy = await readAt(LEGACY_PATHNAME, auth)
    if (legacy) {
      const snapshot = parseRaw(legacy.raw)
      if (snapshot) return { snapshot, etag: null, source: "legacy" }
    }

    return null
  }

  async function readForDisplay(): Promise<ReviewsSnapshot | null> {
    if (pendingDisplayRead) return pendingDisplayRead

    pendingDisplayRead = (async () => {
      try {
        const fresh = await readFresh()
        if (fresh) {
          lastKnownSnapshot = fresh.snapshot
          return fresh.snapshot
        }
        return null
      } catch (error) {
        cfg.hooks.reportError(error, { operation: "readForDisplay" })
        if (!lastKnownSnapshot) return null
        return { ...lastKnownSnapshot, readState: { stale: true, reason: "storage_unavailable" } }
      }
    })()

    try {
      return await pendingDisplayRead
    } finally {
      pendingDisplayRead = null
    }
  }

  function buildPutOptions(auth: Auth, fresh: FreshRead | null) {
    const allowOverwrite = fresh?.source === "v3"
    const ifMatch = fresh?.source === "v3" && fresh.etag !== null ? fresh.etag : undefined
    return {
      ...auth,
      access: "private" as const,
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite,
      cacheControlMaxAge: 60,
      ...(ifMatch !== undefined ? { ifMatch } : {}),
    }
  }

  function serialize(snapshot: ReviewsSnapshot): string {
    const { readState: _readState, ...rest } = snapshot
    return JSON.stringify(rest, null, 2)
  }

  /** Attempts to commit `snapshot` to the v3 pathname via CAS. Returns true on success,
   *  false when a retryable conflict occurred (caller should re-read and retry). */
  async function writeSnapshot(fresh: FreshRead | null, snapshot: ReviewsSnapshot, attempt: number): Promise<boolean> {
    const auth = await resolveAuth()
    try {
      await putFn(v3Pathname, serialize(snapshot), buildPutOptions(auth, fresh))
      lastKnownSnapshot = snapshot
      return true
    } catch (error) {
      if (isConflict(error)) {
        if (attempt < MAX_CAS_ATTEMPTS - 1) {
          await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt)
          return false
        }
        throw new ReviewsError("storage_conflict_exhausted", "Exhausted CAS write retries")
      }
      throw new ReviewsError("storage_unavailable", "Failed to write reviews snapshot", { cause: error })
    }
  }

  /** Re-reads the newest snapshot, runs `attemptOnce` against it, and either returns its
   *  result or retries (on a conflict) up to MAX_CAS_ATTEMPTS times. */
  async function casLoop<T>(
    attemptOnce: (fresh: FreshRead | null, attempt: number) => Promise<{ done: true; value: T } | { done: false }>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      let fresh: FreshRead | null
      try {
        fresh = await readFresh()
      } catch (error) {
        throw new ReviewsError("storage_unavailable", "Failed to read reviews snapshot before write", { cause: error })
      }

      const outcome = await attemptOnce(fresh, attempt)
      if (outcome.done) return outcome.value
    }
    throw new ReviewsError("storage_conflict_exhausted", "Exhausted CAS write retries")
  }

  async function writeReconciled(
    batch: ReconciliationBatch,
  ): Promise<{ result: ReconciliationResult; written: boolean }> {
    return casLoop<{ result: ReconciliationResult; written: boolean }>(async (fresh, attempt) => {
      const base = fresh?.snapshot ?? createEmptySnapshot(cfg.businessName, cfg.locations, nowIso())
      const result = reconcileReviews(base, batch, nowIso())

      if (result.decision !== "applied") {
        return { done: true, value: { result, written: false } }
      }

      const wrote = await writeSnapshot(fresh, result.snapshot, attempt)
      if (!wrote) return { done: false }
      return { done: true, value: { result, written: true } }
    })
  }

  async function updateMetadata(mutate: (snapshot: ReviewsSnapshot) => ReviewsSnapshot | null): Promise<boolean> {
    return casLoop<boolean>(async (fresh, attempt) => {
      const base = fresh?.snapshot ?? createEmptySnapshot(cfg.businessName, cfg.locations, nowIso())
      const mutated = mutate(base)
      if (mutated === null) return { done: true, value: false }

      const wrote = await writeSnapshot(fresh, mutated, attempt)
      if (!wrote) return { done: false }
      return { done: true, value: true }
    })
  }

  async function acquireCronLease(now: Date, ttlMs: number): Promise<boolean> {
    let acquired = false
    await updateMetadata(snapshot => {
      const until = snapshot.metadata.cronLeaseUntil
      if (until && Date.parse(until) > now.getTime()) {
        acquired = false
        return null
      }
      acquired = true
      return {
        ...snapshot,
        metadata: { ...snapshot.metadata, cronLeaseUntil: new Date(now.getTime() + ttlMs).toISOString() },
      }
    })
    return acquired
  }

  async function releaseCronLease(): Promise<void> {
    await updateMetadata(snapshot => ({
      ...snapshot,
      metadata: { ...snapshot.metadata, cronLeaseUntil: null },
    }))
  }

  async function leaseFull(locationKeys: string[], now: Date, ttlMs: number): Promise<string[]> {
    let leased: string[] = []
    await updateMetadata(snapshot => {
      leased = []
      const perLocation = { ...snapshot.metadata.perLocation }
      for (const key of locationKeys) {
        const loc = perLocation[key]
        const until = loc?.fullLeaseUntil
        if (until && Date.parse(until) > now.getTime()) continue
        perLocation[key] = { ...loc, count: loc?.count ?? 0, rating: loc?.rating ?? 0, lastSyncMode: loc?.lastSyncMode ?? null, fullLeaseUntil: new Date(now.getTime() + ttlMs).toISOString() }
        leased.push(key)
      }
      if (leased.length === 0) return null
      return { ...snapshot, metadata: { ...snapshot.metadata, perLocation } }
    })
    return leased
  }

  async function clearFullLease(locationKeys: string[]): Promise<void> {
    await updateMetadata(snapshot => {
      const perLocation = { ...snapshot.metadata.perLocation }
      let changed = false
      for (const key of locationKeys) {
        const loc = perLocation[key]
        if (loc?.fullLeaseUntil) {
          perLocation[key] = { ...loc, fullLeaseUntil: null }
          changed = true
        }
      }
      if (!changed) return null
      return { ...snapshot, metadata: { ...snapshot.metadata, perLocation } }
    })
  }

  async function recordPendingTasks(
    accepted: Array<{ taskId: string; locationKey: string; mode: ReviewSyncMode; depth: number }>,
  ): Promise<void> {
    if (accepted.length === 0) return
    await updateMetadata(snapshot => {
      const createdAt = nowIso()
      return {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          pendingTasks: [...snapshot.metadata.pendingTasks, ...accepted.map(task => ({ ...task, createdAt }))],
        },
      }
    })
  }

  async function removePendingTask(taskId: string): Promise<void> {
    await updateMetadata(snapshot => {
      const pendingTasks = snapshot.metadata.pendingTasks.filter(task => task.taskId !== taskId)
      if (pendingTasks.length === snapshot.metadata.pendingTasks.length) return null
      return { ...snapshot, metadata: { ...snapshot.metadata, pendingTasks } }
    })
  }

  function resetForTests(): void {
    lastKnownSnapshot = null
    pendingDisplayRead = null
  }

  return {
    readFresh,
    readForDisplay,
    writeReconciled,
    updateMetadata,
    acquireCronLease,
    releaseCronLease,
    leaseFull,
    clearFullLease,
    recordPendingTasks,
    removePendingTask,
    resetForTests,
  }
}
