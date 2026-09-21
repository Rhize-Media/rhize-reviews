import { describe, expectTypeOf, test } from "vitest"
import type { GoogleReview, ReviewIdentifier } from "../src/types.js"

describe("types", () => {
  test("GoogleReview rating is a 1-5 union", () => {
    expectTypeOf<GoogleReview["rating"]>().toEqualTypeOf<1 | 2 | 3 | 4 | 5>()
  })

  test("ReviewIdentifier is exhaustively cid | placeId | keyword", () => {
    function assertExhaustive(identifier: ReviewIdentifier): string {
      if ("cid" in identifier) return identifier.cid
      if ("placeId" in identifier) return identifier.placeId
      if ("keyword" in identifier) return identifier.keyword
      // If a new variant is added to ReviewIdentifier, this line fails to compile.
      const exhaustiveCheck: never = identifier
      return exhaustiveCheck
    }

    expectTypeOf(assertExhaustive).returns.toEqualTypeOf<string>()
  })
})
