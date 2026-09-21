# Impact Map: parseTag legacy lookup must honor original-case legacyLocationKeys map keys

## Current behavior and evidence
- `src/dataforseo.ts` `parseTag(tag, legacyLocationKeys?)` extracts a legacy SJG location name
  from `sjg-reviews:<Name>:<mode>:<depth>` or `sjg-reviews-<Name>` and looked it up with
  `legacyLocationKeys[legacyName.toLowerCase()]` — a lowercase-only lookup (evidence:
  `rg -n "legacyLocationKeys" src/dataforseo.ts`, prior line 56 before this fix).
- Coordinator review (fix round 1) found that the documented consumer map is keyed by the
  original SJG capitalized name (`{ Vineland: "vineland", ... }`), so a tag like
  `sjg-reviews:Vineland:full:100` returned `null` instead of resolving.

## Intended semantic delta
- `parseTag` must look up `legacyLocationKeys[legacyName]` first (exact match, honoring whatever
  case the map's keys use), then fall back to a case-insensitive scan over the map's keys, so both
  a lowercase-keyed map and the documented capitalized-keyed map resolve correctly.

## Invariants and must-not-change boundaries
- `rhize-reviews:<key>:<mode>:<depth>` (current-format) parsing is untouched.
- Tags with no matching legacy key, or no `legacyLocationKeys` supplied at all, still return `null`.
- Legacy bare tags (`sjg-reviews-<Name>`) still default to `mode: "incremental"`, `depth: 10`.

## Current structural touchpoints
| Repository | Entry point or symbol | Why affected | Evidence |
|---|---|---|---|
| rhize-reviews-w2-dataforseo | `src/dataforseo.ts::parseTag` | lookup bug fix | `rg -n "parseTag" src/dataforseo.ts tests/dataforseo.test.ts` |
| rhize-reviews-w2-dataforseo | `tests/dataforseo.test.ts` | regression test for exact-case map | same |

## Planned additions and deletions
- Add `lookupCaseInsensitive(map, name)` helper in `src/dataforseo.ts`.
- Add one new test case using the exact map from the finding
  (`{ Vineland, Berlin, Glassboro, Marmora, Wildwood }`) against both
  `sjg-reviews:Vineland:full:100` and `sjg-reviews-Vineland`.

## External and operational effects
- None. Pure in-repo logic fix, no schema/migration/cache/credential impact.

## Reuse opportunities
- N/A — small local helper.

## Acceptance tests
- `parseTag("sjg-reviews:Vineland:full:100", { Vineland: "vineland", ... })` resolves to
  `{ locationKey: "vineland", mode: "full", depth: 100 }`.
- `parseTag("sjg-reviews-Vineland", { Vineland: "vineland", ... })` resolves to
  `{ locationKey: "vineland", mode: "incremental", depth: 10 }`.
- Existing lowercase-map tests and null-path tests remain green.

## Explicitly unaffected paths
- `encodeTag`, `buildPostbackUrl`, `createReviewTasks`, `listReadyTasks`, `getTaskResult`,
  `src/cron.ts::selectTaskRequests` — untouched by this fix.

## Unknowns and confidence
- No `.codegraph/` index exists in this repo (`ls .codegraph` → not found); used `rg` fallback
  evidence for structural touchpoints per the skill's no-CodeGraph branch.

## Implementation order
1. Add regression test with the exact capitalized map from the finding (RED).
2. Fix `parseTag`'s lookup to try the exact key first, then a case-insensitive fallback (GREEN).
3. Re-run `tests/dataforseo.test.ts` and `npm run typecheck`.
4. Commit.
