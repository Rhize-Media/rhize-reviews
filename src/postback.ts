import { gunzipSync } from "node:zlib"
import { ReviewsError } from "./errors.js"

const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1
}

function isBufferTooLarge(error: unknown): boolean {
  if (error instanceof RangeError) return true
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ERR_BUFFER_TOO_LARGE"
}

/**
 * Decode a DataForSEO postback body: gzip-sniffs the raw bytes (magic `1f 8b`),
 * inflating with a bounded `maxOutputLength`, then parses UTF-8 JSON.
 * Throws `ReviewsError("payload_too_large")` when the inflated payload would
 * exceed `maxBytes`, `ReviewsError("payload_invalid")` for any other decode
 * or parse failure.
 */
export function parsePostbackBody(bytes: Uint8Array, maxBytes = 10 * 1024 * 1024): unknown {
  if (bytes.byteLength > maxBytes) {
    throw new ReviewsError("payload_too_large", "Postback payload exceeds the maximum allowed size")
  }

  let decoded: Uint8Array

  if (isGzip(bytes)) {
    try {
      decoded = gunzipSync(Buffer.from(bytes), { maxOutputLength: maxBytes })
    } catch (error) {
      if (isBufferTooLarge(error)) {
        throw new ReviewsError("payload_too_large", "Gzip postback payload exceeds the maximum allowed size", {
          cause: error,
        })
      }
      throw new ReviewsError("payload_invalid", "Failed to inflate gzip postback payload", { cause: error })
    }
  } else {
    decoded = bytes
  }

  const text = new TextDecoder().decode(decoded)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ReviewsError("payload_invalid", "Failed to parse postback payload as JSON", { cause: error })
  }
}
