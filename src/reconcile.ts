import type {
  GoogleReview,
  LocationSyncMetadata,
  ReconciliationBatch,
  ReconciliationChanges,
  ReconciliationDecision,
  ReconciliationResult,
  ReviewLocation,
  ReviewsSnapshot,
  Tombstone,
} from "./types.js"

const REMOVAL_CONFIRMATION_MS = 7 * 24 * 60 * 60 * 1000
const TASK_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const MAX_TASK_RECEIPTS = 250

export class ReviewsError extends Error {
  code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = "ReviewsError"
    this.code = code
  }
}

export function getReviewKey(review: Pick<GoogleReview, "id" | "locationKey">): string {
  return `${review.locationKey}:${review.id}`
}

export function createEmptySnapshot(
  businessName: string,
  locations: ReviewLocation[],
  now: string,
): ReviewsSnapshot {
  const perLocation: Record<string, LocationSyncMetadata> = {}
  for (const location of locations) {
    perLocation[location.key] = { count: 0, rating: 0, lastSyncMode: null }
  }

  return {
    schemaVersion: 3,
    lastUpdated: now,
    reviews: [],
    metadata: {
      businessName,
      averageRating: 0,
      totalReviews: 0,
      perLocation,
      lastSuccessfulWriteAt: now,
      pendingTasks: [],
    },
    processedTasks: [],
    tombstones: [],
  }
}

export function getPublicReviews(
  snapshot: ReviewsSnapshot,
  opts?: { includeStarOnly?: boolean },
): GoogleReview[] {
  return snapshot.reviews.filter(review => {
    if (review.displayable === false) return false
    if (!opts?.includeStarOnly && review.text.trim().length === 0) return false
    return true
  })
}

function emptyChanges(): ReconciliationChanges {
  return {
    added: 0,
    updated: 0,
    unchanged: 0,
    nonDisplayable: 0,
    pendingRemoval: 0,
    removed: 0,
    collisions: 0,
    tombstonesPruned: 0,
  }
}

function comparableReview(review: GoogleReview): Omit<GoogleReview, "pendingRemovalAt"> {
  const { pendingRemovalAt: _pendingRemovalAt, ...rest } = review
  return rest
}

function reviewsEqual(a: GoogleReview, b: GoogleReview): boolean {
  return JSON.stringify(comparableReview(a)) === JSON.stringify(comparableReview(b))
}

function getIncompleteReason(batch: ReconciliationBatch): string | null {
  if (batch.mode !== "full") return "not_full"
  if (!batch.removalEnabled) return "removal_disabled"
  const listingCount = batch.listingReviewCount ?? Infinity
  if (batch.itemsCount < listingCount) return "listing_count_exceeds_items"
  if (batch.itemsCount > batch.requestedDepth) return "requested_depth_truncated"
  return null
}

function computeAggregates(
  reviews: GoogleReview[],
  locationKeys: string[],
): { totalReviews: number; averageRating: number; perLocation: Record<string, { count: number; rating: number }> } {
  const buckets: Record<string, { count: number; sum: number; rated: number }> = {}
  for (const key of locationKeys) buckets[key] = { count: 0, sum: 0, rated: 0 }

  let totalCount = 0
  let totalSum = 0
  let totalRated = 0

  for (const review of reviews) {
    if (review.displayable === false) continue
    totalCount += 1
    totalSum += review.rating
    totalRated += 1

    const bucket = buckets[review.locationKey]
    if (bucket) {
      bucket.count += 1
      bucket.sum += review.rating
      bucket.rated += 1
    }
  }

  const perLocation: Record<string, { count: number; rating: number }> = {}
  for (const key of locationKeys) {
    const bucket = buckets[key]!
    perLocation[key] = { count: bucket.count, rating: bucket.rated > 0 ? bucket.sum / bucket.rated : 0 }
  }

  return {
    totalReviews: totalCount,
    averageRating: totalRated > 0 ? totalSum / totalRated : 0,
    perLocation,
  }
}

export function reconcileReviews(
  current: ReviewsSnapshot,
  batch: ReconciliationBatch,
  now = new Date().toISOString(),
): ReconciliationResult {
  if (!(batch.locationKey in current.metadata.perLocation)) {
    throw new ReviewsError("unknown_location", `Unknown location key: ${batch.locationKey}`)
  }

  const changes = emptyChanges()
  const existingReceipt = current.processedTasks.find(receipt => receipt.taskId === batch.taskId)

  if (existingReceipt) {
    return {
      snapshot: current,
      changes,
      decision: "duplicate_task" satisfies ReconciliationDecision,
      completeFullSnapshot: false,
      incompleteReason: null,
    }
  }

  const previousLocationSync = current.metadata.perLocation[batch.locationKey]
  if (
    previousLocationSync?.lastResultAt &&
    Date.parse(batch.resultAt) < Date.parse(previousLocationSync.lastResultAt)
  ) {
    return {
      snapshot: current,
      changes,
      decision: "out_of_order" satisfies ReconciliationDecision,
      completeFullSnapshot: false,
      incompleteReason: null,
    }
  }

  const reviewsByKey = new Map(current.reviews.map(review => [getReviewKey(review), review]))
  const incomingByKey = new Map<string, GoogleReview>()

  for (const incomingReview of batch.reviews) {
    const normalizedReview: GoogleReview = {
      ...incomingReview,
      locationKey: batch.locationKey,
      displayable: incomingReview.text.trim().length > 0,
      pendingRemovalAt: null,
    }
    const key = getReviewKey(normalizedReview)

    if (incomingByKey.has(key)) changes.collisions += 1
    incomingByKey.set(key, normalizedReview)

    if (
      current.reviews.some(
        review => review.id === normalizedReview.id && review.locationKey !== batch.locationKey,
      )
    ) {
      changes.collisions += 1
    }
  }

  for (const [key, incomingReview] of incomingByKey) {
    const existingReview = reviewsByKey.get(key)
    if (!existingReview) {
      reviewsByKey.set(key, incomingReview)
      changes.added += 1
    } else if (reviewsEqual(existingReview, incomingReview)) {
      reviewsByKey.set(key, { ...existingReview, pendingRemovalAt: null })
      changes.unchanged += 1
    } else {
      reviewsByKey.set(key, incomingReview)
      changes.updated += 1
    }

    if (!incomingReview.displayable) changes.nonDisplayable += 1
  }

  const incompleteReason = getIncompleteReason(batch)
  const completeFullSnapshot = incompleteReason === null

  const tombstones = current.tombstones.filter(tombstone => {
    const keep = Date.parse(now) - Date.parse(tombstone.removedAt) < TOMBSTONE_RETENTION_MS
    if (!keep) changes.tombstonesPruned += 1
    return keep
  })

  if (completeFullSnapshot) {
    for (const [key, review] of reviewsByKey) {
      if (review.locationKey !== batch.locationKey || incomingByKey.has(key)) continue

      if (!review.pendingRemovalAt) {
        reviewsByKey.set(key, { ...review, pendingRemovalAt: now })
        changes.pendingRemoval += 1
        continue
      }

      if (Date.parse(now) - Date.parse(review.pendingRemovalAt) >= REMOVAL_CONFIRMATION_MS) {
        reviewsByKey.delete(key)
        const priorTombstone = tombstones.find(t => t.key === key)
        const tombstone: Tombstone = {
          key,
          firstMissingAt: priorTombstone?.firstMissingAt || review.pendingRemovalAt,
          lastMissingAt: now,
          removedAt: now,
          lastSourceAt: batch.resultAt,
        }
        const priorIndex = tombstones.findIndex(t => t.key === key)
        if (priorIndex >= 0) tombstones[priorIndex] = tombstone
        else tombstones.push(tombstone)
        changes.removed += 1
      }
    }
  }

  const reviews = Array.from(reviewsByKey.values()).sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  )

  const locationKeys = Object.keys(current.metadata.perLocation)
  const aggregates = computeAggregates(reviews, locationKeys)
  const isSingleLocationConfig = locationKeys.length === 1
  const overrideRating =
    isSingleLocationConfig && batch.listingRating !== undefined ? batch.listingRating : undefined

  const perLocation: Record<string, LocationSyncMetadata> = {}
  for (const key of locationKeys) {
    const previous = current.metadata.perLocation[key]
    const computed = aggregates.perLocation[key]!
    const isBatchLocation = key === batch.locationKey

    perLocation[key] = {
      ...previous,
      count: computed.count,
      rating: overrideRating !== undefined ? overrideRating : computed.rating,
      lastSyncMode: isBatchLocation ? batch.mode : (previous?.lastSyncMode ?? null),
      ...(isBatchLocation
        ? {
            lastAcceptedTaskId: batch.taskId,
            lastResultAt: batch.resultAt,
            requestedDepth: batch.requestedDepth,
            itemsCount: batch.itemsCount,
            reviewsCount: batch.reviewsCount,
            incompleteReason,
            ...(batch.mode === "incremental" ? { lastIncrementalAt: now } : {}),
            ...(batch.mode === "full" ? { lastFullAttemptAt: now } : {}),
            ...(completeFullSnapshot ? { lastFullReconciledAt: now } : {}),
          }
        : {}),
    }
  }

  const cutoff = Date.parse(now) - TASK_RECEIPT_RETENTION_MS
  const processedTasks = [
    ...current.processedTasks.filter(receipt => Date.parse(receipt.processedAt) >= cutoff),
    {
      taskId: batch.taskId,
      locationKey: batch.locationKey,
      mode: batch.mode,
      resultAt: batch.resultAt,
      processedAt: now,
    },
  ].slice(-MAX_TASK_RECEIPTS)

  return {
    snapshot: {
      ...current,
      schemaVersion: 3,
      lastUpdated: now,
      reviews,
      metadata: {
        ...current.metadata,
        averageRating: overrideRating !== undefined ? overrideRating : aggregates.averageRating,
        totalReviews: aggregates.totalReviews,
        perLocation,
        lastSuccessfulWriteAt: now,
      },
      processedTasks,
      tombstones,
    },
    changes,
    decision: "applied" satisfies ReconciliationDecision,
    completeFullSnapshot,
    incompleteReason,
  }
}
