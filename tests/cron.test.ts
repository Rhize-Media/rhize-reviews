import { describe, expect, it } from "vitest"
import { selectTaskRequests } from "../src/cron.js"
import type { ReviewLocation, ReviewsSnapshot } from "../src/types.js"

const vineland: ReviewLocation = {
  key: "vineland",
  displayName: "Vineland",
  identifier: { cid: "cid-vineland" },
  locationName: "New Jersey,United States",
}

const now = new Date("2026-09-21T00:00:00.000Z")

const baseOpts = {
  fullEnabled: true,
  forceFull: false,
  incrementalDepth: 10,
  fullCooldownDays: 30,
  now,
}

function snapshotWith(perLocation: ReviewsSnapshot["metadata"]["perLocation"], pendingTasks: ReviewsSnapshot["metadata"]["pendingTasks"] = []): ReviewsSnapshot {
  return {
    schemaVersion: 3,
    lastUpdated: now.toISOString(),
    reviews: [],
    metadata: {
      businessName: "Test",
      averageRating: 0,
      totalReviews: 0,
      perLocation,
      pendingTasks,
    },
    processedTasks: [],
    tombstones: [],
  }
}

describe("selectTaskRequests", () => {
  it("selects incremental for a location with no history when full is not due", () => {
    const result = selectTaskRequests(null, [vineland], { ...baseOpts, fullEnabled: false })
    expect(result).toEqual([{ location: vineland, mode: "incremental", depth: 10 }])
  })

  it("selects full with no prior lastFullReconciledAt (never reconciled = due)", () => {
    const result = selectTaskRequests(null, [vineland], baseOpts)
    expect(result).toEqual([{ location: vineland, mode: "full", depth: 125 }])
  })

  it("clamps full depth to clamp(knownTotal + 25, 100, 500)", () => {
    const snapshot = snapshotWith({
      vineland: { count: 0, rating: 0, lastSyncMode: "incremental", reviewsCount: 600 },
    })
    const result = selectTaskRequests(snapshot, [vineland], baseOpts)
    expect(result).toEqual([{ location: vineland, mode: "full", depth: 500 }])
  })

  it("stays incremental before the cooldown elapses", () => {
    const snapshot = snapshotWith({
      vineland: {
        count: 0,
        rating: 0,
        lastSyncMode: "full",
        lastFullReconciledAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
    })
    const result = selectTaskRequests(snapshot, [vineland], baseOpts)
    expect(result).toEqual([{ location: vineland, mode: "incremental", depth: 10 }])
  })

  it("goes full once the cooldown has elapsed", () => {
    const snapshot = snapshotWith({
      vineland: {
        count: 0,
        rating: 0,
        lastSyncMode: "full",
        lastFullReconciledAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      },
    })
    const result = selectTaskRequests(snapshot, [vineland], baseOpts)
    expect(result[0]?.mode).toBe("full")
  })

  it("forceFull bypasses the cooldown", () => {
    const snapshot = snapshotWith({
      vineland: {
        count: 0,
        rating: 0,
        lastSyncMode: "full",
        lastFullReconciledAt: now.toISOString(),
      },
    })
    const result = selectTaskRequests(snapshot, [vineland], { ...baseOpts, forceFull: true })
    expect(result[0]?.mode).toBe("full")
  })

  it("falls back to incremental when an unexpired fullLeaseUntil is held, even with forceFull", () => {
    const snapshot = snapshotWith({
      vineland: {
        count: 0,
        rating: 0,
        lastSyncMode: "incremental",
        fullLeaseUntil: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      },
    })
    const result = selectTaskRequests(snapshot, [vineland], { ...baseOpts, forceFull: true })
    expect(result).toEqual([{ location: vineland, mode: "incremental", depth: 10 }])
  })

  it("allows full once an expired fullLeaseUntil has passed", () => {
    const snapshot = snapshotWith({
      vineland: {
        count: 0,
        rating: 0,
        lastSyncMode: "incremental",
        fullLeaseUntil: new Date(now.getTime() - 60 * 1000).toISOString(),
      },
    })
    const result = selectTaskRequests(snapshot, [vineland], baseOpts)
    expect(result[0]?.mode).toBe("full")
  })

  it("skips a location with a live pendingTasks entry younger than 1 hour", () => {
    const snapshot = snapshotWith({}, [
      { taskId: "t1", locationKey: "vineland", mode: "incremental", depth: 10, createdAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString() },
    ])
    const result = selectTaskRequests(snapshot, [vineland], baseOpts)
    expect(result).toEqual([])
  })

  it("does not skip a location whose pendingTasks entry is older than 1 hour", () => {
    const snapshot = snapshotWith({}, [
      { taskId: "t1", locationKey: "vineland", mode: "incremental", depth: 10, createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() },
    ])
    const result = selectTaskRequests(snapshot, [vineland], baseOpts)
    expect(result).toHaveLength(1)
  })
})
