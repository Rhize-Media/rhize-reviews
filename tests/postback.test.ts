import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { ReviewsError } from "../src/errors.js"
import { parsePostbackBody } from "../src/postback.js"

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe("parsePostbackBody", () => {
  it("parses plain JSON bytes", () => {
    const payload = { status_code: 20000, tasks: [] }
    const result = parsePostbackBody(bytesOf(JSON.stringify(payload)))
    expect(result).toEqual(payload)
  })

  it("inflates gzip bytes (magic 1f 8b) and parses the JSON inside", () => {
    const payload = { status_code: 20000, tasks: [{ id: "t1" }] }
    const gzipped = gzipSync(Buffer.from(JSON.stringify(payload)))
    const result = parsePostbackBody(new Uint8Array(gzipped))
    expect(result).toEqual(payload)
  })

  it("throws payload_invalid for malformed JSON", () => {
    expect(() => parsePostbackBody(bytesOf("not json"))).toThrow(ReviewsError)
    try {
      parsePostbackBody(bytesOf("not json"))
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewsError)
      expect((error as ReviewsError).code).toBe("payload_invalid")
    }
  })

  it("throws payload_invalid for truncated/corrupt gzip", () => {
    const payload = { status_code: 20000, tasks: [] }
    const gzipped = gzipSync(Buffer.from(JSON.stringify(payload)))
    const truncated = gzipped.subarray(0, gzipped.length - 4)
    expect(() => parsePostbackBody(new Uint8Array(truncated))).toThrow(ReviewsError)
    try {
      parsePostbackBody(new Uint8Array(truncated))
    } catch (error) {
      expect((error as ReviewsError).code).toBe("payload_invalid")
    }
  })

  it("throws payload_too_large for an uncompressed body over maxBytes, before any decode", () => {
    const oversized = bytesOf("x".repeat(101))
    expect(() => parsePostbackBody(oversized, 100)).toThrow(ReviewsError)
    try {
      parsePostbackBody(oversized, 100)
    } catch (error) {
      expect((error as ReviewsError).code).toBe("payload_too_large")
    }
  })

  it("throws payload_too_large when the inflated gzip bomb exceeds maxOutputLength", () => {
    const big = "x".repeat(1_000_000)
    const payload = { status_code: 20000, tasks: [], padding: big }
    const gzipped = gzipSync(Buffer.from(JSON.stringify(payload)))
    expect(() => parsePostbackBody(new Uint8Array(gzipped), 100)).toThrow(ReviewsError)
    try {
      parsePostbackBody(new Uint8Array(gzipped), 100)
    } catch (error) {
      expect((error as ReviewsError).code).toBe("payload_too_large")
    }
  })
})
