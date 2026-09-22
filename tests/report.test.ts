import { describe, expect, it, vi } from "vitest"
import { ReviewsError } from "../src/errors.js"
import { createConsoleReporter, describeReport, safeErrorExtra } from "../src/report.js"

describe("describeReport", () => {
  it("collapses DataForSEO 402s into one fingerprinted error-level message (SJG continuity)", () => {
    const hint = describeReport(new ReviewsError("dataforseo_billing", "DataForSEO Payment Required — check account balance", { endpoint: "/x", errorBodyLength: 3 }))
    expect(hint).toEqual({
      code: "dataforseo_billing",
      level: "error",
      fingerprint: ["dataforseo-billing-402"],
      tags: { "reviews.code": "dataforseo_billing", "dataforseo.error": "billing" },
      message: "DataForSEO account has insufficient funds (402 Payment Required)",
    })
  })

  it("marks operational conditions as warnings with fixed fingerprints", () => {
    expect(describeReport(new ReviewsError("snapshot_stale", "stale"))).toMatchObject({ level: "warning", fingerprint: ["rhize-reviews", "snapshot_stale"] })
    expect(describeReport(new ReviewsError("not_configured", "nc"))).toMatchObject({ level: "warning", fingerprint: ["rhize-reviews", "not_configured"] })
  })

  it("groups task rejections per location", () => {
    const hint = describeReport(new ReviewsError("task_rejected", "rejected"), { locationKey: "berlin" })
    expect(hint.fingerprint).toEqual(["rhize-reviews", "task_rejected", "berlin"])
    expect(hint.level).toBe("error")
  })

  it("leaves genuine failures on default grouping, tagged with the code", () => {
    const hint = describeReport(new ReviewsError("storage_unavailable", "down", { cause: new Error("x") }))
    expect(hint).toEqual({ code: "storage_unavailable", level: "error", tags: { "reviews.code": "storage_unavailable" } })
    expect(hint.fingerprint).toBeUndefined()
    expect(hint.message).toBeUndefined()
  })

  it("treats foreign errors as unknown", () => {
    expect(describeReport(new TypeError("boom"))).toEqual({ code: "unknown", level: "error", tags: { "reviews.code": "unknown" } })
  })
})

describe("safeErrorExtra", () => {
  it("drops cause and returns the rest of ReviewsError.extra", () => {
    const err = new ReviewsError("x", "m", { cause: new Error("inner"), endpoint: "/e" })
    expect(safeErrorExtra(err)).toEqual({ endpoint: "/e" })
    expect(safeErrorExtra(new Error("plain"))).toEqual({})
  })
})

describe("createConsoleReporter", () => {
  it("logs level, code, message, merged context and the error via the matching console method", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const report = createConsoleReporter(logger)
    const billing = new ReviewsError("dataforseo_billing", "m", { endpoint: "/e" })
    report(billing, { handler: "refreshReviewsGET" }, describeReport(billing))
    expect(logger.error).toHaveBeenCalledWith(
      "[reviews] error dataforseo_billing — DataForSEO account has insufficient funds (402 Payment Required)",
      { handler: "refreshReviewsGET", endpoint: "/e" },
      billing,
    )
    const stale = new ReviewsError("snapshot_stale", "s")
    report(stale, { ageMs: 1 })
    expect(logger.warn).toHaveBeenCalledWith("[reviews] warning snapshot_stale", { ageMs: 1 }, stale)
  })
})
