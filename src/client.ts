import { timingSafeEqual } from "node:crypto"
import { ReviewsError } from "./errors.js"
import { createReviewTasks, buildPostbackUrl, encodeTag, getTaskResult, listReadyTasks, parseTag } from "./dataforseo.js"
import { selectTaskRequests } from "./cron.js"
import { normalizeReviewItem, parseListingSummary } from "./normalize.js"
import { getPublicReviews as getPublicReviewsOf } from "./reconcile.js"
import { parsePostbackBody } from "./postback.js"
import { createStorage } from "./storage.js"
import type {
  GoogleReview,
  PostbackResult,
  ReconciliationBatch,
  ReviewLocation,
  ReviewSyncMode,
  ReviewsConfig,
  ReviewsSnapshot,
  RefreshResult,
} from "./types.js"
import { isRecord } from "./util.js"

const MAX_POSTBACK_BYTES = 10 * 1024 * 1024
const CRON_LEASE_MS = 10 * 60 * 1000
const FULL_LEASE_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_INCREMENTAL_DEPTH = 10
const DEFAULT_STALE_AFTER_DAYS = 14
const DEFAULT_FULL_COOLDOWN_DAYS = 30

export interface ReviewsClientDeps {
  storage?: ReturnType<typeof createStorage>
  fetchImpl?: typeof fetch
  legacyLocationKeys?: Record<string, string>
}

export interface ReviewsClient {
  readSnapshot(): Promise<ReviewsSnapshot | null>
  getPublicReviews(snapshot: ReviewsSnapshot | null, opts?: { includeStarOnly?: boolean }): GoogleReview[]
  runRefresh(opts?: { forceFull?: boolean }): Promise<RefreshResult>
  recoverReadyTasks(): Promise<RefreshResult["recovered"]>
  handlePostback(input: { bytes: Uint8Array; query: URLSearchParams; contentLength?: number }): Promise<PostbackResult>
  assertConfigured(): void
  isCronAuthorized(headers: Headers): boolean
  isWebhookAuthorized(query: URLSearchParams): boolean
  reportError: ReviewsConfig["hooks"]["reportError"]
}


function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function errorResult(status: 400 | 401 | 422, error: string): PostbackResult {
  return { status, body: { ok: false, error } }
}

function storageUnavailableResult(): PostbackResult {
  return { status: 503, body: { ok: false, error: "storage_unavailable" } }
}

const DATAFORSEO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{2}):(\d{2})$/

/**
 * Strictly parses a DataForSEO `result[0].datetime` value in its documented
 * shape, `"YYYY-MM-DD HH:MM:SS ±HH:MM"` (e.g. `"2026-09-21 11:00:34 +00:00"`),
 * into an ISO-8601 instant. Returns `null` for anything else — including a
 * value with no timezone offset — so the caller treats it as invalid rather
 * than silently substituting wall-clock time.
 */
function parseDataForSeoDatetime(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = DATAFORSEO_DATETIME_RE.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second, tzHour, tzMinute] = match
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzHour}:${tzMinute}`
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function isStorageError(error: unknown): error is ReviewsError {
  return (
    error instanceof ReviewsError &&
    (error.code === "storage_unavailable" ||
      error.code === "storage_conflict_exhausted" ||
      error.code === "storage_not_configured")
  )
}

export function createReviewsClient(config: ReviewsConfig, deps: ReviewsClientDeps = {}): ReviewsClient {
  const storage = deps.storage ?? createStorage(config)
  const fetchImpl = deps.fetchImpl ?? fetch
  const legacyLocationKeys = deps.legacyLocationKeys

  function nowDate(): Date {
    return config.now?.() ?? new Date()
  }

  function assertConfigured(): void {
    const missing: string[] = []
    if (!config.dataforseo.login) missing.push("dataforseo.login")
    if (!config.dataforseo.password) missing.push("dataforseo.password")
    if (!config.webhook.secret) missing.push("webhook.secret")
    if (!config.cron.secret) missing.push("cron.secret")
    if (!config.storage.storeId && !config.storage.allowReadWriteToken) missing.push("storage.storeId")

    if (!config.webhook.publicBaseUrl) {
      missing.push("webhook.publicBaseUrl")
    } else {
      try {
        const url = new URL(config.webhook.publicBaseUrl)
        if (url.protocol !== "https:" && url.hostname !== "localhost") {
          missing.push("webhook.publicBaseUrl")
        }
      } catch {
        missing.push("webhook.publicBaseUrl")
      }
    }

    if (missing.length > 0) {
      throw new ReviewsError("not_configured", `Reviews client is not configured: ${missing.join(", ")}`, { missing })
    }
  }

  function isCronAuthorized(headers: Headers): boolean {
    if (!config.cron.secret) return false
    const authorization = headers.get("authorization")
    if (!authorization) return false
    return timingSafeEqualStrings(authorization, `Bearer ${config.cron.secret}`)
  }

  /** The constant-time `?secret=` check shared by `isWebhookAuthorized` (so a
   *  caller can authenticate before reading the request body) and
   *  `handlePostback` (which always re-checks it itself). */
  function checkWebhookSecret(query: URLSearchParams): boolean {
    const suppliedSecrets = query.getAll("secret")
    return (
      Boolean(config.webhook.secret) &&
      suppliedSecrets.length === 1 &&
      timingSafeEqualStrings(suppliedSecrets[0]!, config.webhook.secret)
    )
  }

  function isWebhookAuthorized(query: URLSearchParams): boolean {
    return checkWebhookSecret(query)
  }

  async function readSnapshot(): Promise<ReviewsSnapshot | null> {
    return storage.readForDisplay()
  }

  function getPublicReviews(snapshot: ReviewsSnapshot | null, opts?: { includeStarOnly?: boolean }): GoogleReview[] {
    if (!snapshot) return []
    return getPublicReviewsOf(snapshot, opts)
  }

  /**
   * Resolves the location, mode, and depth for an inbound task result:
   * `?tag` and `data.tag` are parsed and must agree when both are present;
   * a single one is used when only one is present; when neither is
   * present, a single-location config falls back to that location
   * (incremental, `incrementalDepth`), while a multi-location config
   * fails to resolve.
   */
  function resolveLocation(
    dataTag: string | null,
    queryTag: string | null,
  ): { location: ReviewLocation; mode: ReviewSyncMode; depth: number } | { error: string } {
    const parsedFromData = dataTag ? parseTag(dataTag, legacyLocationKeys) : null
    const parsedFromQuery = queryTag ? parseTag(queryTag, legacyLocationKeys) : null

    let resolved: { locationKey: string; mode: ReviewSyncMode; depth: number } | null = null

    if (dataTag !== null && queryTag !== null) {
      if (
        !parsedFromData ||
        !parsedFromQuery ||
        parsedFromData.locationKey !== parsedFromQuery.locationKey ||
        parsedFromData.mode !== parsedFromQuery.mode ||
        parsedFromData.depth !== parsedFromQuery.depth
      ) {
        return { error: "tag_conflict" }
      }
      resolved = parsedFromQuery
    } else if (dataTag !== null || queryTag !== null) {
      const only = parsedFromData ?? parsedFromQuery
      if (!only) return { error: "tag_conflict" }
      resolved = only
    }

    if (resolved) {
      const location = config.locations.find(loc => loc.key === resolved!.locationKey)
      if (!location) return { error: "unknown_location" }
      return { location, mode: resolved.mode, depth: resolved.depth }
    }

    if (config.locations.length === 1) {
      return { location: config.locations[0]!, mode: "incremental", depth: config.sync?.incrementalDepth ?? DEFAULT_INCREMENTAL_DEPTH }
    }

    return { error: "tag_required" }
  }

  /**
   * The idempotent core pipeline shared by the webhook (`handlePostback`) and
   * cron recovery (`recoverReadyTasks`): validates the DataForSEO task
   * envelope shape, resolves the target location, normalizes reviews,
   * commits via `storage.writeReconciled`, clears the pending-task record,
   * and revalidates on a successful write.
   */
  async function processTaskEnvelope(
    envelope: unknown,
    source: "postback" | "recovery",
    opts: { queryTag?: string | null; queryId?: string | null } = {},
  ): Promise<PostbackResult> {
    if (!isRecord(envelope) || !Array.isArray(envelope.tasks) || envelope.tasks.length !== 1) {
      return errorResult(422, "invalid_payload_shape")
    }

    const rawTask = envelope.tasks[0]
    if (!isRecord(rawTask) || typeof rawTask.id !== "string" || typeof rawTask.status_code !== "number") {
      return errorResult(422, "invalid_payload_shape")
    }

    if (!Array.isArray(rawTask.result) || rawTask.result.length !== 1) {
      return errorResult(422, "invalid_payload_shape")
    }

    const rawResult = rawTask.result[0]
    if (!isRecord(rawResult)) {
      return errorResult(422, "invalid_payload_shape")
    }

    if (rawTask.status_code !== 20000) {
      config.hooks.reportError(
        new ReviewsError("task_failed", `DataForSEO task returned status_code ${rawTask.status_code}`),
        { taskId: rawTask.id, source },
      )
      return errorResult(422, "task_failed")
    }

    if (source === "postback" && opts.queryId != null && opts.queryId !== rawTask.id) {
      return errorResult(422, "task_id_mismatch")
    }

    const dataTagRaw = isRecord(rawTask.data) ? rawTask.data.tag : undefined
    const dataTag = typeof dataTagRaw === "string" ? dataTagRaw : null
    const queryTag = source === "postback" ? (opts.queryTag ?? null) : null

    const resolution = resolveLocation(dataTag, queryTag)
    if ("error" in resolution) {
      return errorResult(422, resolution.error)
    }

    const { location, mode, depth } = resolution

    const placeId = typeof rawResult.place_id === "string" ? rawResult.place_id : undefined
    if ("placeId" in location.identifier) {
      if (placeId === undefined) return errorResult(422, "place_id_missing")
      if (location.identifier.placeId !== placeId) return errorResult(422, "place_id_mismatch")
    }

    const cid = typeof rawResult.cid === "string" ? rawResult.cid : undefined
    if ("cid" in location.identifier) {
      if (cid === undefined) return errorResult(422, "cid_missing")
      if (location.identifier.cid !== cid) return errorResult(422, "cid_mismatch")
    }

    const resultAt = parseDataForSeoDatetime(rawResult.datetime)
    if (resultAt === null) {
      config.hooks.reportError(
        new ReviewsError("result_datetime_invalid", "DataForSEO result.datetime is missing or not in the expected format"),
        { taskId: rawTask.id, source, datetime: rawResult.datetime },
      )
      return errorResult(422, "result_datetime_invalid")
    }

    const rawItems = Array.isArray(rawResult.items) ? rawResult.items : []
    const normalized = rawItems.map(item => normalizeReviewItem(item, location.key))
    const reviews = normalized.filter((review): review is GoogleReview => review !== null)
    const invalidItemsCount = rawItems.length - reviews.length

    const listingSummary = parseListingSummary(rawResult)

    const batch: ReconciliationBatch = {
      taskId: rawTask.id,
      locationKey: location.key,
      mode,
      resultAt,
      requestedDepth: depth,
      itemsCount: rawItems.length,
      reviewsCount: listingSummary.reviewsCount ?? reviews.length,
      invalidItemsCount,
      reviews,
      removalEnabled: mode === "full" && (config.sync?.removalEnabled ?? false),
      ...(listingSummary.rating !== undefined ? { listingRating: listingSummary.rating } : {}),
      ...(listingSummary.reviewsCount !== undefined ? { listingReviewCount: listingSummary.reviewsCount } : {}),
    }

    let outcome: Awaited<ReturnType<typeof storage.writeReconciled>>
    try {
      outcome = await storage.writeReconciled(batch)
    } catch (error) {
      if (isStorageError(error)) {
        config.hooks.reportError(error, { taskId: batch.taskId, locationKey: batch.locationKey, source })
        return storageUnavailableResult()
      }
      throw error
    }

    try {
      await storage.removePendingTask(batch.taskId)
    } catch (error) {
      config.hooks.reportError(error, { taskId: batch.taskId, operation: "removePendingTask" })
    }

    if (outcome.written) {
      try {
        await config.hooks.revalidate()
      } catch (error) {
        config.hooks.reportError(error, { taskId: batch.taskId, operation: "revalidate" })
      }
    }

    return {
      status: 200,
      body: {
        ok: true,
        taskId: batch.taskId,
        locationKey: batch.locationKey,
        decision: outcome.result.decision,
        changes: outcome.result.changes,
      },
    }
  }

  /**
   * Pulls `tasks_ready` from DataForSEO and feeds each not-yet-processed task
   * through the same pipeline as a postback, via `task_get`. Tasks whose tag
   * doesn't parse to one of this client's own configured locations are
   * skipped without a `task_get` call — `tasks_ready` is a per-DataForSEO-
   * account queue that can carry another tenant's tasks. Does not touch the
   * cron lease: `runRefresh` calls this while already holding it, and a
   * caller invoking it directly runs it unleased.
   */
  async function recoverReadyTasks(): Promise<RefreshResult["recovered"]> {
    const initialFresh = await storage.readFresh()
    const processedIds = new Set((initialFresh?.snapshot.processedTasks ?? []).map(receipt => receipt.taskId))
    const ownLocationKeys = new Set(config.locations.map(location => location.key))

    const readyTasks = await listReadyTasks(config.dataforseo, fetchImpl)
    const recovered: RefreshResult["recovered"] = []

    for (const { id: taskId, tag } of readyTasks) {
      if (processedIds.has(taskId)) continue

      const parsedTag = tag ? parseTag(tag, legacyLocationKeys) : null
      if (!parsedTag || !ownLocationKeys.has(parsedTag.locationKey)) continue

      const envelope = await getTaskResult(config.dataforseo, taskId, fetchImpl)
      const result = await processTaskEnvelope(envelope, "recovery")
      if (result.status === 200) {
        recovered.push({ taskId: result.body.taskId, locationKey: result.body.locationKey, decision: result.body.decision })
      } else {
        config.hooks.reportError(
          new ReviewsError("recovery_task_failed", "Recovery task failed the postback pipeline", {
            taskId,
            status: result.status,
            body: result.body,
          }),
          { taskId, operation: "recovery" },
        )
      }
    }

    return recovered
  }

  async function handlePostback(input: {
    bytes: Uint8Array
    query: URLSearchParams
    contentLength?: number
  }): Promise<PostbackResult> {
    if (!checkWebhookSecret(input.query)) {
      return errorResult(401, "unauthorized")
    }

    if (typeof input.contentLength === "number" && input.contentLength > MAX_POSTBACK_BYTES) {
      return errorResult(400, "payload_too_large")
    }

    let envelope: unknown
    try {
      envelope = parsePostbackBody(input.bytes, MAX_POSTBACK_BYTES)
    } catch (error) {
      if (error instanceof ReviewsError && error.code === "payload_too_large") {
        return errorResult(400, "payload_too_large")
      }
      return errorResult(400, "payload_invalid")
    }

    return processTaskEnvelope(envelope, "postback", {
      queryTag: input.query.get("tag"),
      queryId: input.query.get("id"),
    })
  }

  async function runRefresh(opts: { forceFull?: boolean } = {}): Promise<RefreshResult> {
    assertConfigured()

    const now = nowDate()
    const leaseOwner = await storage.acquireCronLease(now, CRON_LEASE_MS)
    if (!leaseOwner) {
      return { ok: true, recovered: [], accepted: [], rejected: [], skipped: "cron_lease_held" }
    }

    try {
      const recovered = await recoverReadyTasks()

      const freshRead = await storage.readFresh()
      const staleAfterDays = config.sync?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS
      if (freshRead?.snapshot.lastUpdated) {
        const ageMs = now.getTime() - Date.parse(freshRead.snapshot.lastUpdated)
        if (ageMs > staleAfterDays * DAY_MS) {
          config.hooks.reportError(new ReviewsError("snapshot_stale", "Reviews snapshot has not been refreshed recently"), {
            lastUpdated: freshRead.snapshot.lastUpdated,
            ageMs,
          })
        }
      }

      const requested = selectTaskRequests(freshRead?.snapshot ?? null, config.locations, {
        fullEnabled: config.sync?.fullReconciliationEnabled ?? false,
        forceFull: opts.forceFull ?? false,
        incrementalDepth: config.sync?.incrementalDepth ?? DEFAULT_INCREMENTAL_DEPTH,
        fullCooldownDays: config.sync?.fullCooldownDays ?? DEFAULT_FULL_COOLDOWN_DAYS,
        now,
      })

      const fullLocationKeys = requested.filter(r => r.mode === "full").map(r => r.location.key)
      const leased = new Set(fullLocationKeys.length > 0 ? await storage.leaseFull(fullLocationKeys, now, FULL_LEASE_MS) : [])

      const finalRequests = requested.map(r => {
        if (r.mode === "full" && !leased.has(r.location.key)) {
          return { location: r.location, mode: "incremental" as const, depth: config.sync?.incrementalDepth ?? DEFAULT_INCREMENTAL_DEPTH }
        }
        return r
      })

      const postbackUrl = buildPostbackUrl(config.webhook.publicBaseUrl, config.webhook.secret)
      const taskRequests = finalRequests.map(r => ({
        location: r.location,
        mode: r.mode,
        depth: r.depth,
        tag: encodeTag(r.location.key, r.mode, r.depth),
        postbackUrl,
      }))

      let taskResult: Awaited<ReturnType<typeof createReviewTasks>>
      try {
        taskResult = await createReviewTasks(config.dataforseo, taskRequests, fetchImpl)
      } catch (error) {
        if (leased.size > 0) {
          await storage.clearFullLease([...leased])
        }
        throw error
      }
      const { accepted, rejected } = taskResult

      await storage.recordPendingTasks(accepted)

      if (rejected.length > 0) {
        const rejectedFullLocations = rejected
          .filter(r => finalRequests.find(fr => fr.location.key === r.locationKey)?.mode === "full")
          .map(r => r.locationKey)
        if (rejectedFullLocations.length > 0) {
          await storage.clearFullLease(rejectedFullLocations)
        }
        for (const rejection of rejected) {
          config.hooks.reportError(
            new ReviewsError("task_rejected", `DataForSEO rejected the task for ${rejection.locationKey}: ${rejection.statusMessage}`, rejection),
            { locationKey: rejection.locationKey },
          )
        }
      }

      return { ok: true, recovered, accepted, rejected, skipped: null }
    } finally {
      // Best-effort: a release failure must never mask the run's own result or
      // error (e.g. a thrown billing/transport error above). The lease still
      // expires on its own via its TTL.
      try {
        await storage.releaseCronLease(leaseOwner)
      } catch (error) {
        config.hooks.reportError(error, { operation: "releaseCronLease" })
      }
    }
  }

  return {
    readSnapshot,
    getPublicReviews,
    runRefresh,
    recoverReadyTasks,
    handlePostback,
    assertConfigured,
    isCronAuthorized,
    isWebhookAuthorized,
    reportError: config.hooks.reportError,
  }
}
