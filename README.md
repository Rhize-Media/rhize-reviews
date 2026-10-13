# @rhize/reviews

Shared Google reviews pipeline for Rhize-built Next.js sites: a DataForSEO task →
postback webhook → private Vercel Blob snapshot → cached reader, with the reconciliation,
storage, and cron/lease logic in one package instead of duplicated per site.

The package never imports `next/*` or `@sentry/*`. Route handlers take and return
plain WHATWG `Request`/`Response` objects, so you wire them into whatever framework
adapter you're using (Next.js route handlers are the primary target below).

## Install

Install the published package with an exact registry version. The latest published
version is `0.1.4`, including the Blob-read resilience described below.

```json
{
  "dependencies": {
    "@rhize/reviews": "0.1.4"
  }
}
```

Keep consumers on exact registry versions rather than local tarball paths.

Release 0.1.4 was published from reviewed source `f9c4e2c` with the existing
per-command npm credential after CI trusted publishing rejected access (run
38442857760). Registry integrity matches the reviewed tarball; this release has
no CI provenance attestation. Trusted-publisher authentication still needs repair.

## Blob display-read resilience (0.1.4)

`readSnapshot()` coalesces concurrent reads within a client instance. A transient
private Blob 429, 500/502/503/504, Node fetch network failure, or read timeout gets
up to **three attempts**, with jittered exponential delays of 250–500 ms and
500–1000 ms. Every Blob GET has a **five-second abort deadline**, also covering
response-body consumption. A fresh read can try the v3 and legacy paths, so each
attempt can contain two GETs. Authentication/configuration errors, malformed
JSON, missing blobs and unsupported schemas do not trigger transient retries.

Recovered reads emit no error. Exhaustion reports one `storage_unavailable` error
with the original cause and attempt count, then serves a stale copy of the last
successful snapshot if this instance has one. A cold reader with no snapshot
throws; it never reports an unavailable source as a successful empty snapshot.
The in-flight promise is cleared after failure so a later call can recover.

Fresh reads used by cron/CAS writes retain fresh-data-only semantics and do not
use display retries or stale fallback; their Blob requests have the same abort
deadline. Paid-provider calls and write-conflict retries are unchanged.

This fixes the single-attempt read failure observed as SJG-WEBSITE-5K. It cannot
supply old data on a cold instance during a sustained outage. Consumer caches
remain responsible for keeping previously rendered data available across
instances; no new durable cache or dependency is introduced here.

## Configuration

Build a `ReviewsConfig` and pass it to `createReviewsClient`. A typical Next.js
adapter module looks like:

```ts
// lib/reviews.ts
import { createReviewsClient } from "@rhize/reviews"
import * as Sentry from "@sentry/nextjs"
import { revalidateTag } from "next/cache"

export const reviewsClient = createReviewsClient({
  businessName: "Acme Home Services",
  locations: [
    { key: "vineland", displayName: "Vineland", identifier: { cid: "..." }, locationName: "New Jersey,United States" },
    { key: "berlin", displayName: "Berlin", identifier: { placeId: "..." }, locationName: "New Jersey,United States" },
  ],
  dataforseo: {
    login: process.env.DATAFORSEO_LOGIN!,
    password: process.env.DATAFORSEO_PASSWORD!,
  },
  webhook: {
    secret: process.env.DATAFORSEO_WEBHOOK_SECRET!,
    publicBaseUrl: process.env.NEXT_PUBLIC_SITE_URL!,
  },
  cron: {
    secret: process.env.CRON_SECRET!,
  },
  storage: {
    storeId: process.env.REVIEWS_BLOB_STORE_ID,
  },
  sync: {
    fullReconciliationEnabled: false,
    removalEnabled: false,
  },
  hooks: {
    reportError: (error, context) => Sentry.captureException(error, { extra: context }),
    revalidate: () => revalidateTag("reviews"),
  },
})
```

### Error reporting

Every `hooks.reportError(error, context, hint)` call carries a `ReportHint`
(`level`, `tags`, optional `fingerprint` and `message`) computed by
`describeReport`, so recurring operational conditions — a drained DataForSEO
balance (`dataforseo_billing`), a stale snapshot, a missing env var, an
exhausted CAS retry, a per-location task rejection — collapse into one tracker
issue instead of one event per cron run. Two ready-made hooks apply it:

```ts
// Sentry sites — `@rhize/reviews/sentry` never imports @sentry/*; pass your SDK in.
import * as Sentry from "@sentry/nextjs"
import { createSentryReporter } from "@rhize/reviews/sentry"
hooks: { reportError: createSentryReporter(Sentry), revalidate }

// Sites without a tracker — one log line per report: `[reviews] error dataforseo_billing — …`
import { createConsoleReporter } from "@rhize/reviews"
hooks: { reportError: createConsoleReporter(), revalidate }
```

A two-argument hook (`(error, context) => …`) still type-checks; it just ignores
the hint. `dataforseo.timeoutMs` (default 20 000) bounds every DataForSEO request. Hints and `extra` never include the error's `cause` or the postback URL.

`storage` uses store-scoped auth: `storeId` plus a `@vercel/oidc` token. A raw
`BLOB_READ_WRITE_TOKEN` is only honored when you explicitly set
`storage.allowReadWriteToken: true` — production adapters should never set it.

## Route handlers

Wrap `reviewsClient` with `createReviewsHandlers` from the `@rhize/reviews/next`
subpath export and mount the four resulting handlers as Next.js route handlers.
Every route needs the Node runtime (the package uses `node:crypto`/`node:zlib`)
and must not be statically optimized:

```ts
// lib/reviews-handlers.ts
import { createReviewsHandlers } from "@rhize/reviews/next"
import { reviewsClient } from "./reviews"

export const { refreshReviewsGET, dataforseoWebhookPOST, dataforseoWebhookGET, reviewsApiGET } =
  createReviewsHandlers(reviewsClient)
```

```ts
// app/api/cron/refresh-reviews/route.ts
export { refreshReviewsGET as GET } from "@/lib/reviews-handlers"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
```

```ts
// app/api/webhooks/dataforseo/route.ts
export { dataforseoWebhookPOST as POST, dataforseoWebhookGET as GET } from "@/lib/reviews-handlers"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
```

```ts
// app/api/google-reviews/route.ts
export { reviewsApiGET as GET } from "@/lib/reviews-handlers"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
```

- `refreshReviewsGET` — invoked by your cron schedule with
  `Authorization: Bearer <CRON_SECRET>`. Add `?initial=true` for a one-off full
  reconciliation pull (e.g. a manual backfill trigger). Returns 401 if the
  bearer token doesn't match, 503 if the client isn't configured, 502 on a
  DataForSEO billing/transport failure or a rejected task batch, otherwise 200
  with the `RefreshResult` JSON.
- `dataforseoWebhookPOST` — the DataForSEO postback target. Validates the
  `?secret=` query param (constant-time compare) **before reading the request
  body at all** — an unauthenticated or wrongly-secreted request never causes
  the body to be buffered. Then rejects a malformed or negative
  `Content-Length` with 400, and streams the body via its reader, aborting
  with 400 `payload_too_large` the moment the running total exceeds 10 MiB —
  this cap applies even when `Content-Length` is absent or understates the
  body. Once read, the body is transparently gzip-decoded and the task result
  reconciled into the blob snapshot. Returns 503 on a storage failure so
  DataForSEO's webhook resend stays eligible; 401/400/422 are caller faults
  and are not retried. `dataforseoWebhookGET` answers
  `{ ok: true, service: "reviews-webhook" }` for health checks.
- `reviewsApiGET` — the public read endpoint the site's UI fetches. Always
  responds `Cache-Control: no-store` (the blob snapshot is the cache); returns
  `{ reviews: [] , meta: { stale: false, lastUpdated: null, totalReviews: 0,
  averageRating: 0, perLocation: {} } }` when no snapshot has been written yet,
  or 503 `{ ok: false, error: "storage_unavailable" }` (also `no-store`) when
  the blob store itself is unreachable and there is no prior snapshot to fall
  back to. Pass `{ reviewsApiCacheControl }` to `createReviewsHandlers` to
  override the `no-store` default.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | DataForSEO API Basic Auth credentials. |
| `DATAFORSEO_WEBHOOK_SECRET` | Shared secret DataForSEO echoes back as `?secret=` on the postback. |
| `CRON_SECRET` | Bearer token your cron scheduler sends to `refreshReviewsGET`. |
| `NEXT_PUBLIC_SITE_URL` | Public base URL used to build the postback URL DataForSEO calls back to. Must be `https://` (or `http://localhost` in dev). |
| `REVIEWS_BLOB_STORE_ID` | The private Vercel Blob store ID reviews are read from and written to. |

## Provisioning

1. Create a **private** Vercel Blob store for the project and set
   `REVIEWS_BLOB_STORE_ID` to its store ID. Do not enable
   `storage.allowReadWriteToken` in production — the package authenticates to
   the store with `storeId` + a `@vercel/oidc` token instead.
2. Generate `DATAFORSEO_WEBHOOK_SECRET` and `CRON_SECRET` (long random values)
   and set them as environment variables on the deployment.
3. Set `NEXT_PUBLIC_SITE_URL` to the site's public origin so the webhook URL
   DataForSEO calls back to resolves correctly.
4. Point your cron scheduler at `GET /api/cron/refresh-reviews` with
   `Authorization: Bearer <CRON_SECRET>`.

## Resending a missed webhook

If a DataForSEO task's postback never reached the webhook (e.g. the deployment
was mid-redeploy), replay it with DataForSEO's resend endpoint rather than
waiting for the next cron cycle — `runRefresh` also recovers any task still
sitting in `tasks_ready` on its next run, but an explicit resend is faster:

```
POST https://api.dataforseo.com/v3/appendix/webhook_resend
{
  "id": "<task_id>"
}
```

## Security notes

- The DataForSEO postback secret is carried in the `?secret=` query string —
  that's DataForSEO's own webhook contract, not a choice this package makes.
  Because query strings land in access logs, **never log the full webhook URL
  or the raw request URL** in application code; log the path only.
- The comparison of the supplied secret against `webhook.secret` is
  constant-time (`node:crypto.timingSafeEqual`), and an empty configured
  secret never authorizes (`isCronAuthorized` / `isWebhookAuthorized` /
  `handlePostback` all reject outright rather than matching an empty value).
- `dataforseoWebhookPOST` authenticates before reading the request body, and
  `handlePostback` bounds it at 10 MiB by streaming (never buffering past the
  cap) rather than trusting `Content-Length` alone; `parsePostbackBody` also
  rejects an oversized uncompressed payload before attempting to decode it.
- `result.datetime` (the DataForSEO SERP fetch time) is parsed strictly —
  only `"YYYY-MM-DD HH:MM:SS ±HH:MM"` — and used as the review batch's
  `resultAt` for the out-of-order guard. A missing or malformed value is
  rejected with 422 `result_datetime_invalid` rather than substituting
  wall-clock time, which would otherwise let a late-arriving recovery pass
  overwrite newer reconciled data as "older."
- A location configured with `placeId` or `cid` requires the matching
  DataForSEO result field to be present (422 `place_id_missing` /
  `cid_missing`) and to match (422 `place_id_mismatch` / `cid_mismatch`);
  keyword-configured locations are tag-only.
- The cron lease (`runRefresh`) is owned: `acquireCronLease` returns a fresh
  owner id, and only that owner's `releaseCronLease` call can clear it — a
  slow or retried run from an earlier holder can never clear a lease a new
  holder has since acquired. A release failure is reported but never thrown,
  so it can't mask the run's own result or error; the lease still expires on
  its own TTL.
- A reviews snapshot with a `schemaVersion` newer than this package
  understands is never read, migrated, or written over — every storage read
  and CAS write fails closed (`storage_unsupported_schema` /
  `storage_unavailable`) rather than risk clobbering a newer format.
