import type { ReviewLocation, ReviewSyncMode, ReviewsSnapshot } from "./types.js"

const FULL_DEPTH_FLOOR = 100
const FULL_DEPTH_CEILING = 500
const PENDING_TASK_LIVE_WINDOW_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function selectTaskRequests(
  snapshot: ReviewsSnapshot | null,
  locations: ReviewLocation[],
  opts: { fullEnabled: boolean; forceFull: boolean; incrementalDepth: number; fullCooldownDays: number; now: Date },
): Array<{ location: ReviewLocation; mode: ReviewSyncMode; depth: number }> {
  const nowMs = opts.now.getTime()
  const cooldownMs = opts.fullCooldownDays * DAY_MS

  const results: Array<{ location: ReviewLocation; mode: ReviewSyncMode; depth: number }> = []

  for (const location of locations) {
    const pending = snapshot?.metadata.pendingTasks.find(task => task.locationKey === location.key)
    if (pending) {
      const createdAtMs = Date.parse(pending.createdAt)
      if (Number.isFinite(createdAtMs) && nowMs - createdAtMs < PENDING_TASK_LIVE_WINDOW_MS) {
        continue
      }
    }

    const perLocation = snapshot?.metadata.perLocation[location.key]

    const fullLeaseUntilMs = perLocation?.fullLeaseUntil ? Date.parse(perLocation.fullLeaseUntil) : Number.NaN
    const leaseActive = Number.isFinite(fullLeaseUntilMs) && fullLeaseUntilMs > nowMs

    const lastFullReconciledAtMs = perLocation?.lastFullReconciledAt
      ? Date.parse(perLocation.lastFullReconciledAt)
      : Number.NaN
    const cooldownElapsed = !Number.isFinite(lastFullReconciledAtMs) || nowMs - lastFullReconciledAtMs >= cooldownMs

    const fullDue = opts.fullEnabled && !leaseActive && (opts.forceFull || cooldownElapsed)

    if (!fullDue) {
      results.push({ location, mode: "incremental", depth: opts.incrementalDepth })
      continue
    }

    const knownTotal = perLocation?.reviewsCount ?? FULL_DEPTH_FLOOR
    const depth = Math.min(Math.max(knownTotal + 25, FULL_DEPTH_FLOOR), FULL_DEPTH_CEILING)
    results.push({ location, mode: "full", depth })
  }

  return results
}
