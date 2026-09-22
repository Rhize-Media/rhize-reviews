import { ReviewsError } from "./errors.js"

export type ReportLevel = "error" | "warning" | "info"

/**
 * Grouping/severity guidance the package attaches to every `hooks.reportError`
 * call. Consumers forward it to their error tracker (see `@rhize/reviews/sentry`)
 * so recurring operational conditions collapse into one issue instead of one
 * event per cron run, and genuine failures keep their default grouping.
 */
export interface ReportHint {
  /** `ReviewsError.code`, or `"unknown"` for foreign errors. */
  code: string
  level: ReportLevel
  /** Fixed fingerprint for conditions that recur per run; absent = tracker's default grouping. */
  fingerprint?: string[]
  tags: Record<string, string>
  /** When set, report as a message with this text instead of as an exception. */
  message?: string
}

type Rule = { level: ReportLevel; fingerprint?: (error: ReviewsError, context: Record<string, unknown>) => string[]; tags?: Record<string, string>; message?: string }

const BILLING_FINGERPRINT = "dataforseo-billing-402"

// Level choices: `error` for anything that means reviews are not being refreshed
// or stored; `warning` for operational conditions a human must act on but that
// are not code failures (drained balance is still `error`: nothing refreshes
// until someone pays, and the SJG site reported it at that level before the
// package existed — the fingerprint keeps continuity with that Sentry issue).
const RULES: Record<string, Rule> = {
  dataforseo_billing: {
    level: "error",
    fingerprint: () => [BILLING_FINGERPRINT],
    tags: { "dataforseo.error": "billing" },
    message: "DataForSEO account has insufficient funds (402 Payment Required)",
  },
  snapshot_stale: { level: "warning", fingerprint: () => ["rhize-reviews", "snapshot_stale"] },
  not_configured: { level: "warning", fingerprint: () => ["rhize-reviews", "not_configured"] },
  storage_not_configured: { level: "warning", fingerprint: () => ["rhize-reviews", "storage_not_configured"] },
  storage_conflict_exhausted: { level: "error", fingerprint: () => ["rhize-reviews", "storage_conflict_exhausted"] },
  task_no_results: {
    level: "warning",
    fingerprint: (_error, context) => ["rhize-reviews", "task_no_results", String(context.locationKey ?? "unknown")],
  },
  task_rejected: {
    level: "error",
    fingerprint: (_error, context) => ["rhize-reviews", "task_rejected", String(context.locationKey ?? "unknown")],
  },
}

export function describeReport(error: unknown, context: Record<string, unknown> = {}): ReportHint {
  if (!(error instanceof ReviewsError)) {
    return { code: "unknown", level: "error", tags: { "reviews.code": "unknown" } }
  }
  const rule = RULES[error.code]
  const hint: ReportHint = {
    code: error.code,
    level: rule?.level ?? "error",
    tags: { "reviews.code": error.code, ...(rule?.tags ?? {}) },
  }
  const fingerprint = rule?.fingerprint?.(error, context)
  if (fingerprint) hint.fingerprint = fingerprint
  if (rule?.message) hint.message = rule.message
  return hint
}

/** Returns `ReviewsError.extra` minus anything unsafe to ship to a tracker. */
export function safeErrorExtra(error: unknown): Record<string, unknown> {
  if (!(error instanceof ReviewsError) || !error.extra) return {}
  const { cause: _cause, ...rest } = error.extra
  return rest
}

type ConsoleLike = { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void }

/**
 * `hooks.reportError` for consumers without an error tracker: one line per
 * report carrying the level, code and context, so a log search on
 * `[reviews] error dataforseo_billing` finds the condition.
 */
export function createConsoleReporter(logger: ConsoleLike = console) {
  return (error: unknown, context: Record<string, unknown>, hint: ReportHint = describeReport(error, context)): void => {
    const method = hint.level === "error" ? "error" : hint.level === "warning" ? "warn" : "info"
    logger[method](`[reviews] ${hint.level} ${hint.code}${hint.message ? ` — ${hint.message}` : ""}`, { ...context, ...safeErrorExtra(error) }, error)
  }
}
