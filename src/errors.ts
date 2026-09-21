export class ReviewsError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "ReviewsError"
  }
}
