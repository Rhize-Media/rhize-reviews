import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const storeId = process.env.REVIEWS_BLOB_STORE_ID?.trim()

// Opt-in: only runs against a real private Vercel Blob store when
// REVIEWS_BLOB_STORE_ID is set and an authorized Vercel OIDC session is
// available. Verifies the raw @vercel/blob contract this package's storage
// layer (src/storage.ts) relies on — never touches the canonical snapshot.
describe.skipIf(!storeId)("Vercel Blob contract (opt-in)", () => {
  let sdk: typeof import("@vercel/blob")
  let auth: { storeId: string; oidcToken: string }
  let path: string
  let created = false

  beforeAll(async () => {
    if (!storeId) return
    sdk = await import("@vercel/blob")
    const { getVercelOidcToken } = await import("@vercel/oidc")
    auth = { storeId, oidcToken: await getVercelOidcToken() }
    path = `verification/blob-contract-${randomUUID()}.json`
  })

  afterAll(async () => {
    if (!storeId || !created) return
    await sdk.del(path, auth)
  })

  it("rejects a put whose ifMatch does not match the current ETag", async () => {
    const first = await sdk.put(path, JSON.stringify({ v: 1 }), {
      ...auth,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
    })
    created = true
    expect(first.contentType).toBe("application/json")

    await expect(
      sdk.put(path, JSON.stringify({ v: 2 }), {
        ...auth,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        ifMatch: '"not-the-real-etag"',
      }),
    ).rejects.toBeInstanceOf(sdk.BlobPreconditionFailedError)
  })

  it("returns a strong ETag on an identity-encoding read", async () => {
    const result = await sdk.get(path, {
      ...auth,
      access: "private",
      useCache: false,
      headers: { "accept-encoding": "identity" },
    })

    expect(result).not.toBeNull()
    expect(result!.blob.etag).toMatch(/^"[^"\r\n]+"$/)
  })

  it("fails a private get without auth credentials", async () => {
    await expect(sdk.get(path, { access: "private", useCache: false })).rejects.toThrow()
  })
})
