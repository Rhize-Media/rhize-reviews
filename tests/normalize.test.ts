import { describe, expect, test } from "vitest"
import { normalizeReviewItem, parseListingSummary } from "../src/normalize.js"

describe("normalizeReviewItem", () => {
  test("accepts an object rating shape { value: n }", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r1",
        timestamp: "2024-01-15T00:00:00Z",
        rating: { value: 4 },
        review_text: "Great work",
        profile_name: "Jane Doe",
      },
      "loc-1",
    )

    expect(result).toEqual({
      id: "r1",
      locationKey: "loc-1",
      authorName: "Jane Doe",
      rating: 4,
      text: "Great work",
      publishedAt: new Date("2024-01-15T00:00:00Z").toISOString(),
      displayable: true,
    })
  })

  test("accepts a bare numeric rating", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r2",
        timestamp: "2024-01-15T00:00:00Z",
        rating: 3,
        review_text: "Fine",
        profile_name: "John",
      },
      "loc-1",
    )

    expect(result?.rating).toBe(3)
  })

  test("clamps an out-of-range rating (7 -> 5)", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r3",
        timestamp: "2024-01-15T00:00:00Z",
        rating: 7,
        review_text: "Amazing",
        profile_name: "Sam",
      },
      "loc-1",
    )

    expect(result?.rating).toBe(5)
  })

  test("rounds a fractional rating", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r3b",
        timestamp: "2024-01-15T00:00:00Z",
        rating: 3.6,
        review_text: "Good",
        profile_name: "Sam",
      },
      "loc-1",
    )

    expect(result?.rating).toBe(4)
  })

  test("drops items missing review_id", () => {
    const result = normalizeReviewItem(
      {
        timestamp: "2024-01-15T00:00:00Z",
        rating: { value: 4 },
        review_text: "Great",
        profile_name: "Jane",
      },
      "loc-1",
    )

    expect(result).toBeNull()
  })

  test("drops items with an unparseable timestamp", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r4",
        timestamp: "not-a-date",
        rating: { value: 4 },
        review_text: "Great",
        profile_name: "Jane",
      },
      "loc-1",
    )

    expect(result).toBeNull()
  })

  test("drops items with a missing or invalid rating", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r5",
        timestamp: "2024-01-15T00:00:00Z",
        review_text: "Great",
        profile_name: "Jane",
      },
      "loc-1",
    )

    expect(result).toBeNull()
  })

  test("keeps star-only reviews (null review_text) with empty text", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r6",
        timestamp: "2024-01-15T00:00:00Z",
        rating: { value: 5 },
        review_text: null,
        profile_name: "Star Only",
      },
      "loc-1",
    )

    expect(result?.text).toBe("")
    expect(result?.displayable).toBe(true)
  })

  test("defaults profile_name to 'Google reviewer' when missing", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r7",
        timestamp: "2024-01-15T00:00:00Z",
        rating: { value: 5 },
        review_text: "Nice",
      },
      "loc-1",
    )

    expect(result?.authorName).toBe("Google reviewer")
  })

  test("maps time_ago, review_url, and profile_image_url", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r8",
        timestamp: "2024-01-15T00:00:00Z",
        rating: { value: 5 },
        review_text: "Nice",
        profile_name: "Jane",
        time_ago: "2 weeks ago",
        review_url: "https://example.com/review/r8",
        profile_image_url: "https://example.com/avatar.png",
      },
      "loc-1",
    )

    expect(result?.relativeTime).toBe("2 weeks ago")
    expect(result?.reviewUrl).toBe("https://example.com/review/r8")
    expect(result?.profileImageUrl).toBe("https://example.com/avatar.png")
  })

  test("maps owner_answer and owner_timestamp to ownerReply", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r9",
        timestamp: "2024-01-15T00:00:00Z",
        rating: { value: 5 },
        review_text: "Nice",
        profile_name: "Jane",
        owner_answer: "Thank you!",
        owner_timestamp: "2024-01-16T00:00:00Z",
      },
      "loc-1",
    )

    expect(result?.ownerReply).toEqual({
      text: "Thank you!",
      publishedAt: new Date("2024-01-16T00:00:00Z").toISOString(),
    })
  })

  test("omits ownerReply when owner_answer is absent", () => {
    const result = normalizeReviewItem(
      {
        review_id: "r10",
        timestamp: "2024-01-15T00:00:00Z",
        rating: { value: 5 },
        review_text: "Nice",
        profile_name: "Jane",
      },
      "loc-1",
    )

    expect(result?.ownerReply).toBeUndefined()
    expect("ownerReply" in (result as object)).toBe(false)
  })

  test("returns null for a non-object item", () => {
    expect(normalizeReviewItem(null, "loc-1")).toBeNull()
    expect(normalizeReviewItem("not-an-item", "loc-1")).toBeNull()
  })
})

describe("parseListingSummary", () => {
  test("reads rating.value and reviews_count", () => {
    const result = parseListingSummary({
      rating: { value: 4.3 },
      reviews_count: 128,
    })

    expect(result).toEqual({ rating: 4.3, reviewsCount: 128 })
  })

  test("returns an empty object when fields are missing or invalid", () => {
    expect(parseListingSummary({})).toEqual({})
    expect(parseListingSummary(null)).toEqual({})
    expect(parseListingSummary({ rating: "bad", reviews_count: "bad" })).toEqual({})
  })
})
