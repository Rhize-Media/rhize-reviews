import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { migrateSnapshot } from "../src/migrate.js"
import type { ReviewLocation, ReviewsSnapshot } from "../src/types.js"

const NOW = "2026-08-28T16:00:00.000Z"

const LOCATIONS: ReviewLocation[] = [
  { key: "vineland", displayName: "Vineland", identifier: { cid: "1" }, locationName: "Vineland" },
  { key: "berlin", displayName: "Berlin", identifier: { cid: "2" }, locationName: "Berlin" },
  { key: "glassboro", displayName: "Glassboro", identifier: { cid: "3" }, locationName: "Glassboro" },
]

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, "utf8"))
}

describe("migrateSnapshot", () => {
  it("returns a v3 snapshot as-is with readState stripped", () => {
    const v3: ReviewsSnapshot = {
      schemaVersion: 3,
      lastUpdated: NOW,
      reviews: [],
      metadata: {
        businessName: "Biz",
        averageRating: 0,
        totalReviews: 0,
        perLocation: {},
        pendingTasks: [],
      },
      processedTasks: [],
      tombstones: [],
      readState: { stale: true, reason: "test" },
    }

    const result = migrateSnapshot(v3, {
      businessName: "Biz",
      locations: LOCATIONS,
      now: NOW,
    })

    expect(result).not.toBeNull()
    expect(result?.schemaVersion).toBe(3)
    expect(result).not.toHaveProperty("readState")
    expect(result?.metadata.businessName).toBe("Biz")
  })

  it("migrates an SJG v2 snapshot to v3", () => {
    const raw = fixture("sjg-v2.json")
    const result = migrateSnapshot(raw, {
      businessName: "South Jersey Glass & Door",
      locations: LOCATIONS,
      now: NOW,
      legacyLocationKeys: { Vineland: "vineland", Berlin: "berlin", Glassboro: "glassboro" },
    })

    expect(result).not.toBeNull()
    expect(result?.schemaVersion).toBe(3)
    expect(result?.reviews).toHaveLength(2)

    const first = result?.reviews.find(r => r.id === "v2-1")
    expect(first).toMatchObject({
      id: "v2-1",
      locationKey: "vineland",
      authorName: "Alice",
      rating: 5,
      text: "Great door install",
      publishedAt: "2026-08-15T10:00:00.000Z",
      relativeTime: "5 days ago",
      displayable: true,
      ownerReply: { text: "Thanks Alice!", publishedAt: "2026-08-16T00:00:00.000Z" },
    })

    const second = result?.reviews.find(r => r.id === "v2-2")
    expect(second).toMatchObject({ locationKey: "berlin", authorName: "Bob", rating: 4 })

    expect(result?.processedTasks).toEqual([
      {
        taskId: "legacy-task-1",
        locationKey: "vineland",
        mode: "incremental",
        resultAt: "2026-08-15T10:00:00.000Z",
        processedAt: "2026-08-15T10:05:00.000Z",
      },
    ])
    expect(result?.tombstones).toEqual([
      {
        key: "Vineland:gone",
        firstMissingAt: "2026-07-01T00:00:00.000Z",
        lastMissingAt: "2026-07-08T00:00:00.000Z",
        removedAt: "2026-07-08T00:00:00.000Z",
        lastSourceAt: "2026-07-08T00:00:00.000Z",
      },
    ])
    expect(result?.metadata.totalReviews).toBe(2)
  })

  it("migrates an NCS legacy snapshot to v3 with a single location", () => {
    const raw = fixture("ncs-legacy.json")
    const result = migrateSnapshot(raw, {
      businessName: "NCS Business",
      locations: [LOCATIONS[0]!],
      now: NOW,
    })

    expect(result).not.toBeNull()
    expect(result?.schemaVersion).toBe(3)
    expect(result?.reviews).toHaveLength(2)

    const first = result?.reviews.find(r => r.id === "ncs-1")
    expect(first).toMatchObject({
      locationKey: "vineland",
      authorName: "Carol",
      text: "Very happy with the result",
      publishedAt: "2026-08-12T09:00:00.000Z",
      relativeTime: "8 days ago",
      rating: 5,
      ownerReply: { text: "Thank you Carol!" },
      displayable: true,
    })

    expect(result?.metadata.averageRating).toBe(4.5)
    expect(result?.metadata.totalReviews).toBe(2)
    expect(result?.lastUpdated).toBe("2026-08-12T09:30:00.000Z")
    expect(result?.processedTasks).toEqual([])
    expect(result?.tombstones).toEqual([])
  })

  it("marks a star-only SJG v2 review (no text, no explicit displayable) as displayable", () => {
    const raw = {
      schemaVersion: 2,
      lastUpdated: NOW,
      totalReviews: 1,
      reviews: [
        {
          id: "v2-star-only",
          location: "Vineland",
          content: "",
          date: NOW,
          author: "Eve",
          rating: "5",
          type: "google_reviews_search",
        },
      ],
      metadata: { businessName: "Biz", locationBreakdown: { Vineland: 1 } },
      processedTasks: [],
      tombstones: [],
    }

    const result = migrateSnapshot(raw, {
      businessName: "Biz",
      locations: LOCATIONS,
      now: NOW,
      legacyLocationKeys: { Vineland: "vineland" },
    })

    const review = result?.reviews.find(r => r.id === "v2-star-only")
    expect(review?.displayable).toBe(true)
  })

  it("marks a star-only NCS legacy review (empty reviewText) as displayable", () => {
    const raw = {
      items: [
        {
          id: "ncs-star-only",
          profileName: "Frank",
          reviewText: "",
          timestamp: NOW,
          rating: 5,
        },
      ],
      totalCount: 1,
      aggregateRating: 5,
      updatedAt: NOW,
    }

    const result = migrateSnapshot(raw, {
      businessName: "Biz",
      locations: [LOCATIONS[0]!],
      now: NOW,
    })

    const review = result?.reviews.find(r => r.id === "ncs-star-only")
    expect(review?.displayable).toBe(true)
  })

  it("returns null for unrecognizable input", () => {
    expect(
      migrateSnapshot(
        { garbage: true },
        { businessName: "Biz", locations: LOCATIONS, now: NOW },
      ),
    ).toBeNull()
    expect(migrateSnapshot(null, { businessName: "Biz", locations: LOCATIONS, now: NOW })).toBeNull()
    expect(migrateSnapshot("nope", { businessName: "Biz", locations: LOCATIONS, now: NOW })).toBeNull()
  })
})
