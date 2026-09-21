# @rhize/reviews

Shared Google reviews pipeline for Rhize-built Next.js sites: a DataForSEO task →
postback webhook → private Vercel Blob snapshot → cached reader, with the reconciliation,
storage, and cron/lease logic in one package instead of duplicated per site.

The package never imports `next/*` or `@sentry/*`. Route handlers take and return
plain WHATWG `Request`/`Response` objects, so you wire them into whatever framework
adapter you're using (Next.js route handlers are the primary target below).

## Install

Until the registry release lands, consumers install the release candidate as a local
tarball, pinned exactly:

```json
{
  "dependencies": {
    "@rhize/reviews": "file:/Users/jamesdeola/dev-local/RHIZE/rhize-reviews/rhize-reviews-0.1.0-rc.1.tgz"
  }
}
```

Swap that for the published `"@rhize/reviews": "0.1.0"` from the registry once the
package's final review has landed — that dependency diff is expected.

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
  `?secret=` query param (constant-time compare), caps the body at 10 MiB,
  transparently gzip-decodes, and reconciles the task result into the blob
  snapshot. Returns 503 on a storage failure so DataForSEO's webhook resend
  stays eligible; 401/400/422 are caller faults and are not retried.
  `dataforseoWebhookGET` answers `{ ok: true, service: "reviews-webhook" }` for
  health checks.
- `reviewsApiGET` — the public read endpoint the site's UI fetches. Always
  responds `Cache-Control: no-store` (the blob snapshot is the cache); returns
  `{ reviews: [] , meta: { stale: false, lastUpdated: null, totalReviews: 0,
  averageRating: 0, perLocation: {} } }` when no snapshot has been written yet.

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
  constant-time (`node:crypto.timingSafeEqual`).
- `handlePostback` bounds the request body at 10 MiB before attempting to
  gzip-decode or parse it.
