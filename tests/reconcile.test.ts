import { describe, expect, it } from "vitest"
import {
  createEmptySnapshot,
  getPublicReviews,
  getReviewKey,
  reconcileReviews,
  ReviewsError,
} from "../src/reconcile.js"
import type {
  GoogleReview,
  ReconciliationBatch,
  ReviewLocation,
  ReviewsSnapshot,
} from "../src/types.js"

const NOW = "2026-08-28T16:00:00.000Z"

const LOCATIONS: ReviewLocation[] = [
  { key: "vineland", displayName: "Vineland", identifier: { cid: "1" }, locationName: "Vineland" },
  { key: "berlin", displayName: "Berlin", identifier: { cid: "2" }, locationName: "Berlin" },
  { key: "glassboro", displayName: "Glassboro", identifier: { cid: "3" }, locationName: "Glassboro" },
  { key: "marmora", displayName: "Marmora", identifier: { cid: "4" }, locationName: "Marmora" },
  { key: "wildwood", displayName: "Wildwood", identifier: { cid: "5" }, locationName: "Wildwood" },
]

function emptySnapshot(now: string): ReviewsSnapshot {
  return createEmptySnapshot("South Jersey Glass & Door", LOCATIONS, now)
}

function review(
  id: string,
  locationKey = "vineland",
  overrides: Partial<GoogleReview> = {},
): GoogleReview {
  return {
    id,
    locationKey,
    text: `Review ${id}`,
    publishedAt: "2026-08-27T10:00:00.000Z",
    relativeTime: "a day ago",
    authorName: "Reviewer",
    rating: 5,
    reviewUrl: `https://example.com/reviews/${id}`,
    displayable: true,
    pendingRemovalAt: null,
    ...overrides,
  }
}

function batch(
  reviews: GoogleReview[],
  overrides: Partial<ReconciliationBatch> = {},
): ReconciliationBatch {
  return {
    taskId: "task-1",
    locationKey: "vineland",
    mode: "incremental",
    resultAt: "2026-08-28T15:55:00.000Z",
    requestedDepth: 10,
    itemsCount: reviews.length,
    reviewsCount: 100,
    invalidItemsCount: 0,
    reviews,
    removalEnabled: false,
    ...overrides,
  }
}

function withReviews(reviews: GoogleReview[]): ReviewsSnapshot {
  const snapshot = emptySnapshot("2026-08-20T00:00:00.000Z")
  return {
    ...snapshot,
    reviews,
  }
}

describe("reconcileReviews", () => {
  it("replaces every mutable provider field for the same location and ID", () => {
    const original = review("same", "vineland", {
      text: "Old text",
      rating: 2,
      ownerReply: { text: "Old answer" },
      authorName: "Old name",
    })
    const edited = review("same", "vineland", {
      text: "Edited text",
      rating: 5,
      ownerReply: { text: "New answer", publishedAt: "2026-08-28T12:00:00.000Z" },
      authorName: "New name",
      profileImageUrl: "https://example.com/profile.jpg",
      relativeTime: "edited today",
    })

    const result = reconcileReviews(withReviews([original]), batch([edited]), NOW)

    expect(result.changes.updated).toBe(1)
    expect(result.snapshot.reviews).toEqual([edited])
  })

  it("adds new reviews and treats duplicate task delivery as a no-op", () => {
    const first = reconcileReviews(emptySnapshot(NOW), batch([review("new")]), NOW)
    const duplicate = reconcileReviews(first.snapshot, batch([review("new")]), NOW)

    expect(first.changes.added).toBe(1)
    expect(duplicate.decision).toBe("duplicate_task")
    expect(duplicate.snapshot).toEqual(first.snapshot)
  })

  it("uses location-scoped identity while flagging cross-location ID reuse", () => {
    const sharedAtBerlin = review("shared", "berlin")
    const incomingAtVineland = review("shared", "vineland")
    const result = reconcileReviews(
      withReviews([sharedAtBerlin]),
      batch([incomingAtVineland]),
      NOW,
    )

    expect(result.snapshot.reviews).toHaveLength(2)
    expect(result.changes.collisions).toBe(1)
    expect(getReviewKey(result.snapshot.reviews[0]!)).not.toBe(
      getReviewKey(result.snapshot.reviews[1]!),
    )
  })

  it("never removes absent reviews from an incremental or truncated result", () => {
    const original = review("old")
    const incremental = reconcileReviews(
      withReviews([original]),
      batch([], { taskId: "incremental" }),
      NOW,
    )
    const truncatedFull = reconcileReviews(
      incremental.snapshot,
      batch([], {
        taskId: "truncated",
        mode: "full",
        requestedDepth: 10,
        itemsCount: 11,
        reviewsCount: 11,
        listingReviewCount: 11,
        removalEnabled: true,
      }),
      NOW,
    )

    expect(incremental.snapshot.reviews).toContainEqual(original)
    expect(truncatedFull.snapshot.reviews).toContainEqual(original)
    expect(truncatedFull.completeFullSnapshot).toBe(false)
    expect(truncatedFull.incompleteReason).toBe("requested_depth_truncated")
  })

  it("downgrades malformed or partial full payloads to upsert-only", () => {
    const original = review("old")
    const malformed = reconcileReviews(
      withReviews([original]),
      batch([], {
        taskId: "malformed-full",
        mode: "full",
        requestedDepth: 100,
        itemsCount: 1,
        reviewsCount: 1,
        invalidItemsCount: 1,
        listingReviewCount: 50,
        removalEnabled: true,
      }),
      NOW,
    )

    expect(malformed.completeFullSnapshot).toBe(false)
    expect(malformed.incompleteReason).toBe("listing_count_exceeds_items")
    expect(malformed.snapshot.reviews).toContainEqual(original)
  })

  it("requires two complete full snapshots at least seven days apart to remove", () => {
    const original = review("removed")
    const firstAt = "2026-08-01T00:00:00.000Z"
    const secondAt = "2026-08-08T00:00:00.000Z"
    const first = reconcileReviews(
      withReviews([original]),
      batch([], {
        taskId: "full-1",
        mode: "full",
        resultAt: firstAt,
        requestedDepth: 100,
        itemsCount: 0,
        reviewsCount: 0,
        listingReviewCount: 0,
        removalEnabled: true,
      }),
      firstAt,
    )
    const second = reconcileReviews(
      first.snapshot,
      batch([], {
        taskId: "full-2",
        mode: "full",
        resultAt: secondAt,
        requestedDepth: 100,
        itemsCount: 0,
        reviewsCount: 0,
        listingReviewCount: 0,
        removalEnabled: true,
      }),
      secondAt,
    )

    expect(first.changes.pendingRemoval).toBe(1)
    expect(first.snapshot.reviews[0]?.pendingRemovalAt).toBe(firstAt)
    expect(second.changes.removed).toBe(1)
    expect(second.snapshot.reviews).toHaveLength(0)
    expect(second.snapshot.tombstones).toEqual([
      expect.objectContaining({
        key: "vineland:removed",
        firstMissingAt: firstAt,
        removedAt: secondAt,
      }),
    ])
    expect(second.snapshot.tombstones[0]).not.toHaveProperty("text")
  })

  it("keeps a first-miss review when the second full scan is too soon", () => {
    const firstAt = "2026-08-01T00:00:00.000Z"
    const tooSoon = "2026-08-07T23:59:59.000Z"
    const first = reconcileReviews(
      withReviews([review("still-active")]),
      batch([], {
        taskId: "full-1",
        mode: "full",
        resultAt: firstAt,
        requestedDepth: 100,
        itemsCount: 0,
        reviewsCount: 0,
        listingReviewCount: 0,
        removalEnabled: true,
      }),
      firstAt,
    )
    const second = reconcileReviews(
      first.snapshot,
      batch([], {
        taskId: "full-2",
        mode: "full",
        resultAt: tooSoon,
        requestedDepth: 100,
        itemsCount: 0,
        reviewsCount: 0,
        listingReviewCount: 0,
        removalEnabled: true,
      }),
      tooSoon,
    )

    expect(second.snapshot.reviews).toHaveLength(1)
    expect(second.changes.removed).toBe(0)
  })

  it("clears pending removal when the review reappears", () => {
    const pending = review("returned", "vineland", {
      pendingRemovalAt: "2026-08-01T00:00:00.000Z",
    })
    const result = reconcileReviews(withReviews([pending]), batch([review("returned")]), NOW)

    expect(result.snapshot.reviews[0]?.pendingRemovalAt).toBeNull()
  })

  it("keeps a same-ID empty-text (star-only) review displayable but flags it", () => {
    const result = reconcileReviews(
      withReviews([review("emptied")]),
      batch([review("emptied", "vineland", { text: "" })]),
      NOW,
    )

    expect(result.snapshot.reviews[0]?.displayable).toBe(true)
    expect(result.snapshot.metadata.totalReviews).toBe(1)
    expect(result.changes.nonDisplayable).toBe(1)
  })

  it("returns a star-only review from getPublicReviews only with includeStarOnly", () => {
    const result = reconcileReviews(
      emptySnapshot(NOW),
      batch([review("star-only", "vineland", { text: "" })]),
      NOW,
    )

    expect(getPublicReviews(result.snapshot)).toHaveLength(0)
    expect(getPublicReviews(result.snapshot, { includeStarOnly: true })).toHaveLength(1)
    expect(getPublicReviews(result.snapshot, { includeStarOnly: true })[0]?.id).toBe("star-only")
  })

  it("ignores older out-of-order results", () => {
    const latest = reconcileReviews(
      emptySnapshot(NOW),
      batch([review("latest")], {
        taskId: "latest-task",
        resultAt: "2026-08-28T12:00:00.000Z",
      }),
      NOW,
    )
    const older = reconcileReviews(
      latest.snapshot,
      batch([review("older")], {
        taskId: "older-task",
        resultAt: "2026-08-27T12:00:00.000Z",
      }),
      NOW,
    )

    expect(older.decision).toBe("out_of_order")
    expect(older.snapshot).toEqual(latest.snapshot)
  })

  it("gives a single-location config a perLocation with one key", () => {
    const snapshot = createEmptySnapshot("Solo Biz", [LOCATIONS[0]!], NOW)
    expect(Object.keys(snapshot.metadata.perLocation)).toEqual(["vineland"])
  })

  it("throws ReviewsError('unknown_location') for a batch targeting an unconfigured location", () => {
    expect(() =>
      reconcileReviews(emptySnapshot(NOW), batch([review("x", "nowhere")], { locationKey: "nowhere" }), NOW),
    ).toThrow(ReviewsError)
    try {
      reconcileReviews(emptySnapshot(NOW), batch([review("x", "nowhere")], { locationKey: "nowhere" }), NOW)
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewsError)
      expect((err as ReviewsError).code).toBe("unknown_location")
    }
  })

  it("does not remove when the listing count (600) exceeds a truncated depth (500)", () => {
    const original = review("kept")
    const result = reconcileReviews(
      withReviews([original]),
      batch([], {
        taskId: "full-truncated",
        mode: "full",
        requestedDepth: 500,
        itemsCount: 500,
        reviewsCount: 500,
        listingReviewCount: 600,
        removalEnabled: true,
      }),
      NOW,
    )

    expect(result.completeFullSnapshot).toBe(false)
    expect(result.snapshot.reviews).toContainEqual(original)
  })

  it("does not remove when the listing has grown beyond depth since the last known total", () => {
    const knownTotal = 200
    const original = review("kept-2")
    const result = reconcileReviews(
      withReviews([original]),
      batch([], {
        taskId: "full-grown",
        mode: "full",
        requestedDepth: knownTotal + 25,
        itemsCount: knownTotal + 25,
        reviewsCount: knownTotal + 25,
        listingReviewCount: knownTotal + 40,
        removalEnabled: true,
      }),
      NOW,
    )

    expect(result.completeFullSnapshot).toBe(false)
    expect(result.snapshot.reviews).toContainEqual(original)
  })

  it("uses listingReviewCount as the total for a single-location config, not the stored subset", () => {
    const solo = createEmptySnapshot("Solo Biz", [LOCATIONS[0]!], "2026-08-20T00:00:00.000Z")
    const withStored = { ...solo, reviews: [review("a"), review("b"), review("c")] }

    const result = reconcileReviews(
      withStored,
      batch([], {
        taskId: "solo-listing-count",
        mode: "incremental",
        listingReviewCount: 4,
      }),
      NOW,
    )

    expect(result.snapshot.metadata.totalReviews).toBe(4)
    expect(result.snapshot.metadata.perLocation["vineland"]?.count).toBe(4)
  })

  it("clears the location's full lease when a full batch is applied", () => {
    const withLease = withReviews([])
    withLease.metadata.perLocation["vineland"] = {
      ...withLease.metadata.perLocation["vineland"]!,
      fullLeaseUntil: "2026-08-29T00:00:00.000Z",
    }

    const result = reconcileReviews(
      withLease,
      batch([], {
        taskId: "full-clears-lease",
        mode: "full",
        requestedDepth: 10,
        itemsCount: 0,
        reviewsCount: 0,
        removalEnabled: false,
      }),
      NOW,
    )

    expect(result.snapshot.metadata.perLocation["vineland"]?.fullLeaseUntil).toBeNull()
  })
})
