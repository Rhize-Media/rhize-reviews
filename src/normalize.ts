import type { GoogleReview } from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function parseRating(value: unknown): 1 | 2 | 3 | 4 | 5 | null {
  const raw = isRecord(value) ? value.value : value
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  const clamped = Math.min(5, Math.max(1, Math.round(raw)))
  return clamped as 1 | 2 | 3 | 4 | 5
}

/**
 * Normalize a single DataForSEO review item into a `GoogleReview`.
 * Returns `null` when required fields (review_id, a parseable timestamp,
 * or a valid rating) are missing or invalid. Star-only reviews (no text)
 * are kept, with `text: ""`.
 */
export function normalizeReviewItem(item: unknown, locationKey: string): GoogleReview | null {
  if (!isRecord(item)) return null

  const { review_id: reviewId } = item
  if (typeof reviewId !== "string" || reviewId.length === 0) return null

  const publishedAt = parseTimestamp(item.timestamp)
  if (publishedAt === null) return null

  const rating = parseRating(item.rating)
  if (rating === null) return null

  const rawText = item.review_text
  const text = typeof rawText === "string" ? rawText : ""

  const rawProfileName = item.profile_name
  const authorName = typeof rawProfileName === "string" && rawProfileName.length > 0 ? rawProfileName : "Google reviewer"

  const review: GoogleReview = {
    id: reviewId,
    locationKey,
    authorName,
    rating,
    text,
    publishedAt,
    displayable: true,
  }

  if (typeof item.time_ago === "string") review.relativeTime = item.time_ago
  if (typeof item.review_url === "string") review.reviewUrl = item.review_url
  if (typeof item.profile_image_url === "string") review.profileImageUrl = item.profile_image_url

  if (typeof item.owner_answer === "string") {
    const ownerPublishedAt = parseTimestamp(item.owner_timestamp)
    review.ownerReply = ownerPublishedAt === null ? { text: item.owner_answer } : { text: item.owner_answer, publishedAt: ownerPublishedAt }
  }

  return review
}

/**
 * Read the aggregate rating and review count off a DataForSEO listing
 * result. Fields are omitted (not `undefined`) when absent or invalid.
 */
export function parseListingSummary(result: unknown): { rating?: number; reviewsCount?: number } {
  if (!isRecord(result)) return {}

  const summary: { rating?: number; reviewsCount?: number } = {}

  const rawRating = isRecord(result.rating) ? result.rating.value : result.rating
  if (typeof rawRating === "number" && Number.isFinite(rawRating)) summary.rating = rawRating

  const rawCount = result.reviews_count
  if (typeof rawCount === "number" && Number.isFinite(rawCount)) summary.reviewsCount = rawCount

  return summary
}
