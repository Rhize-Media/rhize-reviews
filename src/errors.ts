export class ReviewsError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    // Node/ES2022 `cause` so Sentry's linkedErrors and console.error show the
    // underlying failure (the Blob error behind storage_unavailable, etc.).
    super(message, extra?.cause !== undefined ? { cause: extra.cause } : undefined)
    this.name = "ReviewsError"
  }
}
