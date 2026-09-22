import { describe, expect, it } from "vitest"
import { ReviewsError } from "../src/errors.js"
import {
  buildPostbackUrl,
  createReviewTasks,
  encodeTag,
  getTaskResult,
  listReadyTasks,
  parseTag,
} from "../src/dataforseo.js"
import type { ReviewLocation } from "../src/types.js"

const cfg = { login: "user", password: "pass" }

const vinelandCid: ReviewLocation = {
  key: "vineland",
  displayName: "Vineland",
  identifier: { cid: "cid-vineland" },
  locationName: "New Jersey,United States",
}

const berlinPlaceId: ReviewLocation = {
  key: "berlin",
  displayName: "Berlin",
  identifier: { placeId: "place-berlin" },
  locationName: "New Jersey,United States",
}

const glassboroKeyword: ReviewLocation = {
  key: "glassboro",
  displayName: "Glassboro",
  identifier: { keyword: "Glassboro Glass Door" },
  locationName: "New Jersey,United States",
}

describe("tag round-trip", () => {
  it("round-trips location, mode, and depth", () => {
    const tag = encodeTag("glassboro", "full", 125)
    expect(tag).toBe("rhize-reviews:glassboro:full:125")
    expect(parseTag(tag)).toEqual({ locationKey: "glassboro", mode: "full", depth: 125 })
  })

  it("accepts SJG legacy tagged tags via legacyLocationKeys map", () => {
    const legacyLocationKeys = { vineland: "vineland" }
    expect(parseTag("sjg-reviews:vineland:full:200", legacyLocationKeys)).toEqual({
      locationKey: "vineland",
      mode: "full",
      depth: 200,
    })
  })

  it("accepts SJG legacy bare tags as incremental depth 10 without enabling deletion", () => {
    const legacyLocationKeys = { vineland: "vineland" }
    expect(parseTag("sjg-reviews-vineland", legacyLocationKeys)).toEqual({
      locationKey: "vineland",
      mode: "incremental",
      depth: 10,
    })
    expect(parseTag("sjg-reviews-unknown", legacyLocationKeys)).toBeNull()
  })

  it("looks up the legacyLocationKeys map keyed by the original SJG (capitalized) name", () => {
    const legacyLocationKeys = {
      Vineland: "vineland",
      Berlin: "berlin",
      Glassboro: "glassboro",
      Marmora: "marmora",
      Wildwood: "wildwood",
    }
    expect(parseTag("sjg-reviews:Vineland:full:100", legacyLocationKeys)).toEqual({
      locationKey: "vineland",
      mode: "full",
      depth: 100,
    })
    expect(parseTag("sjg-reviews-Vineland", legacyLocationKeys)).toEqual({
      locationKey: "vineland",
      mode: "incremental",
      depth: 10,
    })
  })

  it("returns null for legacy tags when no legacyLocationKeys map is supplied", () => {
    expect(parseTag("sjg-reviews-vineland")).toBeNull()
  })

  it("returns null for garbage tags", () => {
    expect(parseTag("not-a-tag")).toBeNull()
  })
})

describe("buildPostbackUrl", () => {
  it("preserves $id and $tag literally, not percent-encoded", () => {
    const url = buildPostbackUrl("https://example.com", "s3cr3t")
    expect(url).toBe(
      "https://example.com/api/webhooks/dataforseo?secret=s3cr3t&id=$id&tag=$tag",
    )
    expect(url).not.toContain("%24")
  })

  it("percent-encodes the secret", () => {
    const url = buildPostbackUrl("https://example.com", "s c/r?et")
    expect(url).toContain("secret=s%20c%2Fr%3Fet")
  })
})

describe("createReviewTasks", () => {
  const requestFor = (location: ReviewLocation, mode: "incremental" | "full" = "incremental", depth = 10) => ({
    location,
    mode,
    depth,
    tag: encodeTag(location.key, mode, depth),
    postbackUrl: "https://example.com/api/webhooks/dataforseo?secret=echoed-secret&id=$id&tag=$tag",
  })

  it("builds the cid identifier field for a cid location", async () => {
    let sentBody: unknown
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return Response.json({ status_code: 20000, tasks: [{ id: "t1", status_code: 20100, status_message: "Task Created." }] })
    }) as typeof fetch

    await createReviewTasks(cfg, [requestFor(vinelandCid)], fetchImpl)

    expect(sentBody).toEqual([
      {
        cid: "cid-vineland",
        location_name: "New Jersey,United States",
        language_name: "English",
        depth: 10,
        sort_by: "newest",
        tag: "rhize-reviews:vineland:incremental:10",
        postback_url: "https://example.com/api/webhooks/dataforseo?secret=echoed-secret&id=$id&tag=$tag",
      },
    ])
  })

  it("builds the place_id identifier field for a placeId location", async () => {
    let sentBody: unknown
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return Response.json({ status_code: 20000, tasks: [{ id: "t1", status_code: 20100, status_message: "Task Created." }] })
    }) as typeof fetch

    await createReviewTasks(cfg, [requestFor(berlinPlaceId)], fetchImpl)

    expect((sentBody as Array<Record<string, unknown>>)[0]).toMatchObject({ place_id: "place-berlin" })
  })

  it("builds the keyword identifier field for a keyword location", async () => {
    let sentBody: unknown
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return Response.json({ status_code: 20000, tasks: [{ id: "t1", status_code: 20100, status_message: "Task Created." }] })
    }) as typeof fetch

    await createReviewTasks(cfg, [requestFor(glassboroKeyword)], fetchImpl)

    expect((sentBody as Array<Record<string, unknown>>)[0]).toMatchObject({ keyword: "Glassboro Glass Door" })
  })

  it("accepts tasks with status 20100 or 20000 and excludes rejected tasks into rejected[]", async () => {
    const fetchImpl = (async () =>
      Response.json({
        status_code: 20000,
        tasks: [
          { id: "created-task", status_code: 20100, status_message: "Task Created." },
          { id: "failed-task", status_code: 40501, status_message: "Invalid field" },
        ],
      })) as typeof fetch

    const result = await createReviewTasks(
      cfg,
      [requestFor(vinelandCid), requestFor(berlinPlaceId)],
      fetchImpl,
    )

    expect(result.accepted).toEqual([
      { taskId: "created-task", locationKey: "vineland", mode: "incremental", depth: 10 },
    ])
    expect(result.rejected).toEqual([
      { locationKey: "berlin", statusCode: 40501, statusMessage: "Invalid field" },
    ])
  })

  it("throws dataforseo_billing on 402 without leaking the response body", async () => {
    const fetchImpl = (async () =>
      new Response("invalid postback_url=https://example.com/callback?secret=echoed-secret", {
        status: 402,
        statusText: "Payment Required",
      })) as typeof fetch

    let caught: unknown
    try {
      await createReviewTasks(cfg, [requestFor(vinelandCid)], fetchImpl)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ReviewsError)
    expect((caught as ReviewsError).code).toBe("dataforseo_billing")
    expect(JSON.stringify(caught)).not.toContain("echoed-secret")
    expect((caught as ReviewsError).extra).toMatchObject({ errorBodyLength: expect.any(Number) })
  })

  it("throws task_rejected when the envelope status_code is not 20000", async () => {
    const fetchImpl = (async () =>
      Response.json({ status_code: 40000, status_message: "bad request", tasks: null })) as typeof fetch

    let caught: unknown
    try {
      await createReviewTasks(cfg, [requestFor(vinelandCid)], fetchImpl)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ReviewsError)
    expect((caught as ReviewsError).code).toBe("task_rejected")
  })
})

describe("listReadyTasks", () => {
  it("parses task ids and tags out of the tasks_ready envelope", async () => {
    const fetchImpl = (async () =>
      Response.json({
        status_code: 20000,
        tasks: [{ result: [{ id: "task-1", tag: "rhize-reviews:vineland:incremental:10" }, { id: "task-2" }] }],
      })) as typeof fetch

    const ids = await listReadyTasks(cfg, fetchImpl)
    expect(ids).toEqual([
      { id: "task-1", tag: "rhize-reviews:vineland:incremental:10" },
      { id: "task-2", tag: null },
    ])
  })

  it("returns an empty array when there is nothing ready", async () => {
    const fetchImpl = (async () => Response.json({ status_code: 20000, tasks: [{ result: [] }] })) as typeof fetch
    expect(await listReadyTasks(cfg, fetchImpl)).toEqual([])
  })
})

describe("getTaskResult", () => {
  it("returns the same envelope shape a postback would deliver", async () => {
    const envelope = { status_code: 20000, tasks: [{ id: "task-1", status_code: 20000, result: [{ items: [] }] }] }
    const fetchImpl = (async () => Response.json(envelope)) as typeof fetch

    const result = await getTaskResult(cfg, "task-1", fetchImpl)
    expect(result).toEqual(envelope)
  })
})

describe("request timeouts", () => {
  it("attaches an AbortSignal to task_post, tasks_ready and task_get, honoring dataforseo.timeoutMs", async () => {
    const seen: Array<{ url: string; signal: unknown }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, signal: init.signal })
      if (url.includes("task_post")) return Response.json({ status_code: 20000, tasks: [{ id: "t", status_code: 20100 }] })
      if (url.includes("tasks_ready")) return Response.json({ tasks: [{ result: [] }] })
      return Response.json({ tasks: [{ id: "t", status_code: 20000, result: [] }] })
    }) as unknown as typeof fetch
    const timed = { ...cfg, timeoutMs: 1234 }
    const request = { location: vinelandCid, mode: "incremental" as const, depth: 10, tag: encodeTag("vineland", "incremental", 10), postbackUrl: "https://example.com/api/webhooks/dataforseo?secret=s" }
    await createReviewTasks(timed, [request], fetchImpl)
    await listReadyTasks(timed, fetchImpl)
    await getTaskResult(timed, "t", fetchImpl)
    expect(seen).toHaveLength(3)
    for (const call of seen) expect(call.signal).toBeInstanceOf(AbortSignal)
  })
})
