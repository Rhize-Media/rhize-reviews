export type ReviewIdentifier = { cid: string } | { placeId: string } | { keyword: string }

export interface ReviewLocation {
  key: string
  displayName: string
  identifier: ReviewIdentifier
  locationName: string
  languageName?: string
}

export type ReviewSyncMode = "incremental" | "full"

export interface GoogleReview {
  id: string
  locationKey: string
  authorName: string
  rating: 1 | 2 | 3 | 4 | 5
  text: string
  publishedAt: string
  relativeTime?: string
  reviewUrl?: string
  profileImageUrl?: string
  ownerReply?: { text: string; publishedAt?: string }
  displayable: boolean
  pendingRemovalAt?: string | null
}

export interface LocationSyncMetadata {
  count: number
  rating: number
  lastSyncMode: ReviewSyncMode | null
  fullLeaseUntil?: string | null
  lastAcceptedTaskId?: string
  lastResultAt?: string
  lastIncrementalAt?: string
  lastFullAttemptAt?: string
  lastFullReconciledAt?: string
  requestedDepth?: number
  itemsCount?: number
  reviewsCount?: number
  incompleteReason?: string | null
}

export interface TaskReceipt {
  taskId: string
  locationKey: string
  mode: ReviewSyncMode
  resultAt: string
  processedAt: string
}

export interface Tombstone {
  key: string
  firstMissingAt: string
  lastMissingAt: string
  removedAt: string
  lastSourceAt: string
}

export interface ReviewsSnapshot {
  schemaVersion: 3
  lastUpdated: string
  reviews: GoogleReview[]
  metadata: {
    businessName: string
    averageRating: number
    totalReviews: number
    perLocation: Record<string, LocationSyncMetadata>
    lastSuccessfulWriteAt?: string
    cronLeaseUntil?: string | null
    cronLeaseOwner?: string | null
    pendingTasks: Array<{ taskId: string; locationKey: string; mode: ReviewSyncMode; depth: number; createdAt: string }>
  }
  processedTasks: TaskReceipt[]
  tombstones: Tombstone[]
  readState?: { stale: boolean; reason?: string }
}

export interface ReconciliationBatch {
  taskId: string
  locationKey: string
  mode: ReviewSyncMode
  resultAt: string
  requestedDepth: number
  itemsCount: number
  reviewsCount: number
  invalidItemsCount: number
  listingRating?: number
  listingReviewCount?: number
  reviews: GoogleReview[]
  removalEnabled: boolean
}

export interface ReconciliationChanges {
  added: number
  updated: number
  unchanged: number
  nonDisplayable: number
  pendingRemoval: number
  removed: number
  collisions: number
  tombstonesPruned: number
}

export type ReconciliationDecision = "applied" | "duplicate_task" | "out_of_order"

export interface ReconciliationResult {
  snapshot: ReviewsSnapshot
  changes: ReconciliationChanges
  decision: ReconciliationDecision
  completeFullSnapshot: boolean
  incompleteReason: string | null
}

export interface ReviewsConfig {
  businessName: string
  locations: ReviewLocation[]
  dataforseo: { login: string; password: string; baseUrl?: string }
  webhook: { secret: string; publicBaseUrl: string }
  cron: { secret: string }
  storage: { storeId?: string; allowReadWriteToken?: boolean; pathname?: string }
  sync?: {
    fullReconciliationEnabled?: boolean
    removalEnabled?: boolean
    incrementalDepth?: number
    staleAfterDays?: number
    fullCooldownDays?: number
  }
  hooks: { reportError: (error: unknown, context: Record<string, unknown>) => void; revalidate: () => void | Promise<void> }
  now?: () => Date
}

export interface RefreshResult {
  ok: true
  recovered: Array<{ taskId: string; locationKey: string; decision: ReconciliationDecision }>
  accepted: Array<{ taskId: string; locationKey: string; mode: ReviewSyncMode; depth: number }>
  rejected: Array<{ locationKey: string; statusCode: number; statusMessage: string }>
  skipped: "cron_lease_held" | null
}

export type PostbackResult =
  | { status: 200; body: { ok: true; taskId: string; locationKey: string; decision: ReconciliationDecision; changes: ReconciliationChanges } }
  | { status: 400 | 401 | 422; body: { ok: false; error: string } }
  | { status: 503; body: { ok: false; error: "storage_unavailable" } }
