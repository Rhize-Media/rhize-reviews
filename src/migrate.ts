import type { GoogleReview, LocationSyncMetadata, ReviewLocation, ReviewsSnapshot, TaskReceipt } from "./types.js"
import { isRecord } from "./util.js"
import { computeAggregates } from "./reconcile.js"

export interface MigrateContext {
  businessName: string
  locations: ReviewLocation[]
  now: string
  legacyLocationKeys?: Record<string, string>
}


function isV3Snapshot(raw: unknown): raw is ReviewsSnapshot {
  return isRecord(raw) && raw.schemaVersion === 3
}

function isSjgV2(raw: unknown): raw is Record<string, unknown> {
  if (!isRecord(raw)) return false
  const reviews = raw.reviews
  const metadata = raw.metadata
  if (!Array.isArray(reviews)) return false
  if (!isRecord(metadata) || !isRecord(metadata.locationBreakdown)) return false
  if (reviews.length > 0 && !isRecord(reviews[0])) return false
  if (reviews.length > 0 && typeof (reviews[0] as Record<string, unknown>).content !== "string") return false
  return true
}

function isNcsLegacy(raw: unknown): raw is Record<string, unknown> {
  if (!isRecord(raw)) return false
  if ("schemaVersion" in raw) return false
  if (!Array.isArray(raw.items) || typeof raw.totalCount !== "number") return false

  if (raw.items.length === 0) {
    // A valid empty NCS legacy export: no items yet, but NCS legacy always
    // writes aggregateRating (even when 0) alongside totalCount.
    return typeof raw.aggregateRating === "number"
  }

  const first = raw.items[0]
  if (!isRecord(first)) return false
  const hasReviewId = typeof first.reviewId === "string"
  const hasId = typeof first.id === "string" || typeof first.id === "number"
  if (!hasReviewId && !hasId) return false
  if (typeof first.rating !== "number" || !Number.isFinite(first.rating)) return false
  return true
}

function toRating(value: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = Math.round(Number(value))
  if (n <= 1) return 1
  if (n >= 5) return 5
  return n as 1 | 2 | 3 | 4 | 5
}

/** Finds the legacy `metadata.locations[Name]` watermark entry (keyed by the
 *  original SJG display name) whose mapped key equals `key`, so it can be
 *  carried into the migrated `perLocation[key]`. */
function findLegacyLocationMeta(
  locationsRaw: Record<string, unknown> | undefined,
  key: string,
  legacyLocationKeys: Record<string, string>,
): Record<string, unknown> | undefined {
  if (!locationsRaw) return undefined
  for (const [name, value] of Object.entries(locationsRaw)) {
    const mappedKey = legacyLocationKeys[name] ?? name
    if (mappedKey === key && isRecord(value)) return value
  }
  return undefined
}

function migrateSjgV2(raw: Record<string, unknown>, ctx: MigrateContext): ReviewsSnapshot {
  const legacyLocationKeys = ctx.legacyLocationKeys ?? {}
  const rawReviews = Array.isArray(raw.reviews) ? (raw.reviews as Record<string, unknown>[]) : []
  const metadata = isRecord(raw.metadata) ? raw.metadata : {}

  const reviews: GoogleReview[] = rawReviews.map(review => {
    const legacyLocation = typeof review.location === "string" ? review.location : ""
    const locationKey = legacyLocationKeys[legacyLocation] ?? legacyLocation
    const text = typeof review.content === "string" ? review.content : ""
    const ownerAnswer = typeof review.owner_answer === "string" ? review.owner_answer : undefined

    const migrated: GoogleReview = {
      id: String(review.id),
      locationKey,
      authorName: typeof review.author === "string" ? review.author : "",
      rating: toRating(review.rating),
      text,
      publishedAt: typeof review.date === "string" ? review.date : ctx.now,
      displayable: typeof review.displayable === "boolean" ? review.displayable : true,
      pendingRemovalAt: typeof review.pendingRemovalAt === "string" ? review.pendingRemovalAt : null,
    }
    if (typeof review.time_ago === "string") migrated.relativeTime = review.time_ago
    if (typeof review.review_url === "string") migrated.reviewUrl = review.review_url
    if (typeof review.profile_image_url === "string") migrated.profileImageUrl = review.profile_image_url
    if (ownerAnswer) {
      migrated.ownerReply =
        typeof review.owner_date === "string"
          ? { text: ownerAnswer, publishedAt: review.owner_date }
          : { text: ownerAnswer }
    }
    return migrated
  })

  const processedTasksRaw = Array.isArray(raw.processedTasks) ? (raw.processedTasks as Record<string, unknown>[]) : []
  const processedTasks: TaskReceipt[] = processedTasksRaw.map(task => {
    const legacyLocation = typeof task.location === "string" ? task.location : ""
    return {
      taskId: String(task.taskId),
      locationKey: legacyLocationKeys[legacyLocation] ?? legacyLocation,
      mode: task.mode === "full" ? "full" : "incremental",
      resultAt: typeof task.resultAt === "string" ? task.resultAt : ctx.now,
      processedAt: typeof task.processedAt === "string" ? task.processedAt : ctx.now,
    }
  })

  const tombstones = Array.isArray(raw.tombstones) ? raw.tombstones : []

  const locationKeys = ctx.locations.map(l => l.key)
  const aggregates = computeAggregates(reviews, locationKeys)
  const locationsRaw = isRecord(metadata.locations) ? metadata.locations : undefined
  const perLocation: Record<string, LocationSyncMetadata> = {}
  for (const key of locationKeys) {
    const computed = aggregates.perLocation[key]!
    const legacyMeta = findLegacyLocationMeta(locationsRaw, key, legacyLocationKeys)
    perLocation[key] = {
      count: computed.count,
      rating: computed.rating,
      lastSyncMode: null,
      ...(legacyMeta && typeof legacyMeta.lastResultAt === "string" ? { lastResultAt: legacyMeta.lastResultAt } : {}),
      ...(legacyMeta && typeof legacyMeta.lastIncrementalAt === "string" ? { lastIncrementalAt: legacyMeta.lastIncrementalAt } : {}),
      ...(legacyMeta && typeof legacyMeta.lastFullAttemptAt === "string" ? { lastFullAttemptAt: legacyMeta.lastFullAttemptAt } : {}),
      ...(legacyMeta && typeof legacyMeta.lastFullReconciledAt === "string"
        ? { lastFullReconciledAt: legacyMeta.lastFullReconciledAt }
        : {}),
      ...(legacyMeta && typeof legacyMeta.requestedDepth === "number" ? { requestedDepth: legacyMeta.requestedDepth } : {}),
      ...(legacyMeta && typeof legacyMeta.itemsCount === "number" ? { itemsCount: legacyMeta.itemsCount } : {}),
      ...(legacyMeta && typeof legacyMeta.reviewsCount === "number" ? { reviewsCount: legacyMeta.reviewsCount } : {}),
      ...(legacyMeta && typeof legacyMeta.incompleteReason === "string" ? { incompleteReason: legacyMeta.incompleteReason } : {}),
      ...(legacyMeta && typeof legacyMeta.lastAcceptedTaskId === "string" ? { lastAcceptedTaskId: legacyMeta.lastAcceptedTaskId } : {}),
    }
  }

  const lastUpdated = typeof raw.lastUpdated === "string" ? raw.lastUpdated : ctx.now

  return {
    schemaVersion: 3,
    lastUpdated,
    reviews,
    metadata: {
      businessName: typeof metadata.businessName === "string" ? metadata.businessName : ctx.businessName,
      averageRating: aggregates.averageRating,
      totalReviews: aggregates.totalReviews,
      perLocation,
      lastSuccessfulWriteAt:
        typeof metadata.lastSuccessfulWriteAt === "string" ? metadata.lastSuccessfulWriteAt : lastUpdated,
      pendingTasks: [],
    },
    processedTasks,
    tombstones: tombstones as ReviewsSnapshot["tombstones"],
  }
}

function migrateNcsLegacy(raw: Record<string, unknown>, ctx: MigrateContext): ReviewsSnapshot {
  const locationKey = ctx.locations[0]?.key ?? "default"
  const items = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : []

  const reviews: GoogleReview[] = items.map((item, index) => {
    const text = typeof item.reviewText === "string" ? item.reviewText : ""
    const ownerAnswer = typeof item.ownerAnswer === "string" ? item.ownerAnswer : undefined
    const reviewId = typeof item.reviewId === "string" ? item.reviewId : item.id !== undefined ? String(item.id) : undefined

    const migrated: GoogleReview = {
      id: reviewId ?? String(index),
      locationKey,
      authorName: typeof item.profileName === "string" ? item.profileName : "",
      rating: toRating(item.rating),
      text,
      publishedAt: typeof item.timestamp === "string" ? item.timestamp : ctx.now,
      displayable: true,
      pendingRemovalAt: null,
    }
    if (typeof item.timeAgo === "string") migrated.relativeTime = item.timeAgo
    if (typeof item.reviewUrl === "string") migrated.reviewUrl = item.reviewUrl
    if (typeof item.profileImageUrl === "string") migrated.profileImageUrl = item.profileImageUrl
    if (ownerAnswer) {
      migrated.ownerReply =
        typeof item.ownerTimestamp === "string" ? { text: ownerAnswer, publishedAt: item.ownerTimestamp } : { text: ownerAnswer }
    }
    return migrated
  })

  const averageRating = typeof raw.aggregateRating === "number" ? raw.aggregateRating : 0
  const totalReviews = typeof raw.totalCount === "number" ? raw.totalCount : reviews.length
  const lastUpdated = typeof raw.updatedAt === "string" ? raw.updatedAt : ctx.now

  return {
    schemaVersion: 3,
    lastUpdated,
    reviews,
    metadata: {
      businessName: ctx.businessName,
      averageRating,
      totalReviews,
      perLocation: { [locationKey]: { count: reviews.length, rating: averageRating, lastSyncMode: null } },
      lastSuccessfulWriteAt: lastUpdated,
      pendingTasks: [],
    },
    processedTasks: [],
    tombstones: [],
  }
}

export function migrateSnapshot(raw: unknown, ctx: MigrateContext): ReviewsSnapshot | null {
  if (isV3Snapshot(raw)) {
    const { readState: _readState, ...rest } = raw
    return rest as ReviewsSnapshot
  }

  if (isSjgV2(raw)) return migrateSjgV2(raw, ctx)
  if (isNcsLegacy(raw)) return migrateNcsLegacy(raw, ctx)

  return null
}
