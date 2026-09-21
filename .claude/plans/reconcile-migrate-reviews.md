# Impact Map: reconcile.ts + migrate.ts (tasks A4/A5)

## Current behavior and evidence
- Fresh package `@rhize/reviews` scaffold (`src/types.ts`, `src/index.ts` only). No
  reconciliation or migration logic existed before this change. `.codegraph/` absent; used
  `rg`/targeted reads over the reference source
  `clients/sjg-new-website/next-frontend/src/lib/reviews-reconciliation.ts` and
  `.../src/types/index.ts:300-492`.

## Intended semantic delta
- Add `src/reconcile.ts`: `reconcileReviews`, `createEmptySnapshot`, `getReviewKey`,
  `getPublicReviews`, generalized from the SJG single-tenant port to arbitrary
  `ReviewLocation[]`, schema v3 shapes, and a simplified `completeFullSnapshot` formula
  driven by `listingReviewCount`.
- Add `src/migrate.ts`: `migrateSnapshot(raw, ctx)` recognizing v3 (pass-through, strip
  `readState`), SJG v2 (`reviews[].content` + `locationBreakdown`), and NCS legacy
  (`items[]` + `totalCount`) shapes, returning `null` for anything else.

## Invariants and must-not-change boundaries
- Package never imports `next/*` or `@sentry/*`.
- `schemaVersion: 3`; `readState` never persisted.
- Removals (tombstones) only fire when `completeFullSnapshot` is true.
- Duplicate `taskId` -> `duplicate_task`, no snapshot mutation.
- Older `resultAt` for a location than its last accepted result -> `out_of_order`, no mutation.
- `src/index.ts` is NOT edited by this task (a later wave wires exports).

## Current structural touchpoints
| Repository | Entry point or symbol | Why affected | Evidence |
|---|---|---|---|
| rhize-reviews-w2-reconcile | `src/reconcile.ts` (new) | core reconciliation port | ported from SJG `reviews-reconciliation.ts` |
| rhize-reviews-w2-reconcile | `src/migrate.ts` (new) | legacy snapshot migration | ported logic from SJG `migrateStoredReviewsData` + NCS shape per brief |
| rhize-reviews-w2-reconcile | `tests/reconcile.test.ts`, `tests/migrate.test.ts` (new) | coverage | port of SJG's 10-case suite + new cases from brief |

## Planned additions and deletions
- New: `src/reconcile.ts`, `src/migrate.ts`, `tests/reconcile.test.ts`, `tests/migrate.test.ts`,
  `tests/fixtures/sjg-v2.json`, `tests/fixtures/ncs-legacy.json`.
- Follow-up (this session, post-coordinator review): extract `ReviewsError` into `src/errors.ts`
  to match a sibling branch's canonical shape, adjust `displayable`/`getPublicReviews` semantics,
  single-location `listingReviewCount` count override, and full-batch lease clearing.

## External and operational effects
- None (pure functions, no I/O, no Blob/DataForSEO calls in this task).

## Reuse opportunities
- None found; this is the first implementation of reconciliation/migration in this package.

## Acceptance tests
- `tests/reconcile.test.ts` (14+ cases): update/add/duplicate/collision/out-of-order,
  incremental never removes, malformed/truncated full downgrades, two-full-scans-7-days-apart
  removal + tombstone, pending-removal clears on reappearance, empty-text non-displayable,
  single-location `perLocation`, unknown-location throw, `completeFullSnapshot` edge cases
  (listing count > depth; grown listing since known total).
- `tests/migrate.test.ts` (4 cases): v3 passthrough strips `readState`; SJG v2 field mapping;
  NCS legacy field mapping; null for garbage input.

## Explicitly unaffected paths
- `src/types.ts`, `src/index.ts` — untouched.
- Blob storage, DataForSEO client, webhook/cron routes — out of scope for this wave.

## Unknowns and confidence
- No `.codegraph/` index in this repo; relied on `rg` + full-file reads of the reference source
  and `src/types.ts`. Coordinator-supplied fixes (errors.ts dedupe, displayable semantics,
  listing-count override, full-batch lease clear) are being folded in now.

## Implementation order
1. Port `reconcileReviews`/`createEmptySnapshot`/`getReviewKey`/`getPublicReviews` with tests (A4).
2. Port `migrateSnapshot` with fixtures and tests (A5).
3. Fold in coordinator review: shared `ReviewsError`, `displayable` semantics fix, listing-count
   total override, full-batch lease clear — each with a test — then reconcile.
