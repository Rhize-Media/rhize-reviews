import { describeReport, safeErrorExtra, type ReportHint, type ReportLevel } from "../report.js"

type CaptureContext = {
  level?: ReportLevel
  fingerprint?: string[]
  tags?: Record<string, string>
  extra?: Record<string, unknown>
}

/**
 * The slice of the Sentry SDK the reporter needs. Structural so the package
 * never imports `@sentry/*`; pass `import * as Sentry from "@sentry/nextjs"`.
 */
export interface SentryLike {
  captureException: (error: unknown, context?: CaptureContext) => unknown
  captureMessage: (message: string, context?: CaptureContext) => unknown
}

/**
 * `hooks.reportError` for Sentry consumers. Applies the package's report hints:
 * conditions with a `message` (a drained DataForSEO balance) become one
 * fingerprinted message; everything else is an exception with the hint's
 * level, fingerprint and tags. `extra` carries the hook context plus the
 * error's own extra (never its `cause`, never the postback URL).
 */
export function createSentryReporter(sentry: SentryLike, options: { extra?: Record<string, unknown> } = {}) {
  return (error: unknown, context: Record<string, unknown>, hint: ReportHint = describeReport(error, context)): void => {
    const capture: CaptureContext = {
      level: hint.level,
      tags: hint.tags,
      extra: { ...options.extra, ...context, ...safeErrorExtra(error) },
    }
    if (hint.fingerprint) capture.fingerprint = hint.fingerprint
    if (hint.message) {
      sentry.captureMessage(hint.message, capture)
      return
    }
    sentry.captureException(error, capture)
  }
}
