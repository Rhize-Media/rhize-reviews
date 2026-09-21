import type { GoogleReview, LocationSyncMetadata, ReviewLocation, ReviewsSnapshot, TaskReceipt } from "./types.js"

export interface MigrateContext {
  businessName: string
  locations: ReviewLocation[]
  now: string
  legacyLocationKeys?: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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
  return Array.isArray(raw.items) && typeof raw.totalCount === "number"
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

function toRating(value: unknown): 1 | 2 | 3 | 4 | 5 {
  const n = Math.round(Number(value))
  if (n <= 1) return 1
  if (n >= 5) return 5
  return n as 1 | 2 | 3 | 4 | 5
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
      displayable: typeof review.displayable === "boolean" ? review.displayable : text.trim().length > 0,
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
  const perLocation: Record<string, LocationSyncMetadata> = {}
  for (const key of locationKeys) {
    const computed = aggregates.perLocation[key]!
    perLocation[key] = { count: computed.count, rating: computed.rating, lastSyncMode: null }
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

    const migrated: GoogleReview = {
      id: item.id !== undefined ? String(item.id) : String(index),
      locationKey,
      authorName: typeof item.profileName === "string" ? item.profileName : "",
      rating: toRating(item.rating),
      text,
      publishedAt: typeof item.timestamp === "string" ? item.timestamp : ctx.now,
      displayable: text.trim().length > 0,
      pendingRemovalAt: null,
    }
    if (typeof item.timeAgo === "string") migrated.relativeTime = item.timeAgo
    if (typeof item.reviewUrl === "string") migrated.reviewUrl = item.reviewUrl
    if (typeof item.profileImageUrl === "string") migrated.profileImageUrl = item.profileImageUrl
    if (ownerAnswer) migrated.ownerReply = { text: ownerAnswer }
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
