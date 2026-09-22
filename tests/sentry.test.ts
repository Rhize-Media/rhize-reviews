import { describe, expect, it, vi } from "vitest"
import { ReviewsError } from "../src/errors.js"
import { describeReport } from "../src/report.js"
import { createSentryReporter } from "../src/sentry/index.js"

function fakeSentry() {
  return { captureException: vi.fn(), captureMessage: vi.fn() }
}

describe("createSentryReporter", () => {
  it("reports a 402 as ONE fingerprinted message with the hook context and safe extra", () => {
    const sentry = fakeSentry()
    const report = createSentryReporter(sentry, { extra: { site: "sjg" } })
    const error = new ReviewsError("dataforseo_billing", "m", { endpoint: "/task_post", errorBodyLength: 12, cause: new Error("raw body") })

    report(error, { handler: "refreshReviewsGET", code: "dataforseo_billing" }, describeReport(error))

    expect(sentry.captureException).not.toHaveBeenCalled()
    expect(sentry.captureMessage).toHaveBeenCalledWith("DataForSEO account has insufficient funds (402 Payment Required)", {
      level: "error",
      fingerprint: ["dataforseo-billing-402"],
      tags: { "reviews.code": "dataforseo_billing", "dataforseo.error": "billing" },
      extra: { site: "sjg", handler: "refreshReviewsGET", code: "dataforseo_billing", endpoint: "/task_post", errorBodyLength: 12 },
    })
    expect(JSON.stringify(sentry.captureMessage.mock.calls[0])).not.toContain("raw body")
  })

  it("reports other failures as exceptions with level and tags, and no fingerprint override", () => {
    const sentry = fakeSentry()
    const report = createSentryReporter(sentry)
    const error = new ReviewsError("storage_unavailable", "Failed to write reviews snapshot: down", { cause: new Error("down") })

    report(error, { taskId: "t1", operation: "removePendingTask" }, describeReport(error))

    expect(sentry.captureMessage).not.toHaveBeenCalled()
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      level: "error",
      tags: { "reviews.code": "storage_unavailable" },
      extra: { taskId: "t1", operation: "removePendingTask" },
    })
  })

  it("computes the hint itself when a caller omits it (2-arg use)", () => {
    const sentry = fakeSentry()
    const report = createSentryReporter(sentry)
    report(new ReviewsError("snapshot_stale", "s"), { ageMs: 5 })
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(ReviewsError), expect.objectContaining({ level: "warning", fingerprint: ["rhize-reviews", "snapshot_stale"] }))
  })
})
