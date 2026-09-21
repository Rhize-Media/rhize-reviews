import { ReviewsError } from "./errors.js"
import type { ReviewLocation, ReviewSyncMode, ReviewsConfig } from "./types.js"

const DEFAULT_BASE_URL = "https://api.dataforseo.com/v3"

type DataForSEOConfig = ReviewsConfig["dataforseo"]

function authHeader(cfg: DataForSEOConfig): string {
  return `Basic ${Buffer.from(`${cfg.login}:${cfg.password}`).toString("base64")}`
}

function baseUrl(cfg: DataForSEOConfig): string {
  return cfg.baseUrl ?? DEFAULT_BASE_URL
}

async function throwForFailedResponse(endpoint: string, response: Response): Promise<never> {
  const errorBody = await response.text().catch(() => "")
  if (response.status === 402) {
    throw new ReviewsError(
      "dataforseo_billing",
      "DataForSEO Payment Required — check account balance",
      { endpoint, errorBodyLength: errorBody.length },
    )
  }
  throw new ReviewsError(
    "dataforseo_request_failed",
    `DataForSEO API error: ${response.status} ${response.statusText}`,
    { endpoint, status: response.status, errorBodyLength: errorBody.length },
  )
}

export function encodeTag(locationKey: string, mode: ReviewSyncMode, depth: number): string {
  return `rhize-reviews:${locationKey}:${mode}:${depth}`
}

export function parseTag(
  tag: string,
  legacyLocationKeys?: Record<string, string>,
): { locationKey: string; mode: ReviewSyncMode; depth: number } | null {
  const current = tag.match(/^rhize-reviews:([^:]+):(incremental|full):(\d+)$/)
  if (current) {
    return {
      locationKey: current[1]!,
      mode: current[2] as ReviewSyncMode,
      depth: Number.parseInt(current[3]!, 10),
    }
  }

  if (!legacyLocationKeys) return null

  const legacyTagged = tag.match(/^sjg-reviews:([^:]+):(incremental|full):(\d+)$/)
  const legacyBare = tag.match(/^sjg-reviews-([^:]+)$/)
  const legacyName = legacyTagged?.[1] ?? legacyBare?.[1]
  if (!legacyName) return null

  const locationKey = legacyLocationKeys[legacyName.toLowerCase()]
  if (!locationKey) return null

  return {
    locationKey,
    mode: (legacyTagged?.[2] as ReviewSyncMode | undefined) ?? "incremental",
    depth: legacyTagged?.[3] ? Number.parseInt(legacyTagged[3], 10) : 10,
  }
}

export function buildPostbackUrl(publicBaseUrl: string, secret: string): string {
  const base = new URL("/api/webhooks/dataforseo", publicBaseUrl).toString()
  return `${base}?secret=${encodeURIComponent(secret)}&id=$id&tag=$tag`
}

function identifierField(location: ReviewLocation): Record<string, string> {
  const identifier = location.identifier
  if ("cid" in identifier) return { cid: identifier.cid }
  if ("placeId" in identifier) return { place_id: identifier.placeId }
  return { keyword: identifier.keyword }
}

export async function createReviewTasks(
  cfg: DataForSEOConfig,
  requests: Array<{ location: ReviewLocation; mode: ReviewSyncMode; depth: number; tag: string; postbackUrl: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  accepted: Array<{ taskId: string; locationKey: string; mode: ReviewSyncMode; depth: number }>
  rejected: Array<{ locationKey: string; statusCode: number; statusMessage: string }>
}> {
  const payload = requests.map(request => ({
    ...identifierField(request.location),
    location_name: request.location.locationName,
    language_name: request.location.languageName ?? "English",
    depth: request.depth,
    sort_by: "newest",
    tag: request.tag,
    postback_url: request.postbackUrl,
  }))

  const response = await fetchImpl(`${baseUrl(cfg)}/business_data/google/reviews/task_post`, {
    method: "POST",
    headers: { Authorization: authHeader(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    await throwForFailedResponse("task_post", response)
  }

  const data = (await response.json()) as {
    status_code: number
    status_message?: string
    tasks?: Array<{ id?: string; status_code: number; status_message?: string }>
  }

  if (data.status_code !== 20000 || !data.tasks) {
    throw new ReviewsError(
      "task_rejected",
      `DataForSEO error: ${data.status_message ?? "unknown"}`,
      { statusCode: data.status_code },
    )
  }

  const accepted: Array<{ taskId: string; locationKey: string; mode: ReviewSyncMode; depth: number }> = []
  const rejected: Array<{ locationKey: string; statusCode: number; statusMessage: string }> = []

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i]!
    const task = data.tasks[i]

    if (task && (task.status_code === 20000 || task.status_code === 20100) && task.id) {
      accepted.push({
        taskId: task.id,
        locationKey: request.location.key,
        mode: request.mode,
        depth: request.depth,
      })
    } else {
      rejected.push({
        locationKey: request.location.key,
        statusCode: task?.status_code ?? 0,
        statusMessage: task?.status_message ?? "missing task in response",
      })
    }
  }

  return { accepted, rejected }
}

export async function listReadyTasks(cfg: DataForSEOConfig, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchImpl(`${baseUrl(cfg)}/business_data/google/reviews/tasks_ready`, {
    method: "GET",
    headers: { Authorization: authHeader(cfg) },
  })

  if (!response.ok) {
    await throwForFailedResponse("tasks_ready", response)
  }

  const data = (await response.json()) as { tasks?: Array<{ result?: Array<{ id: string }> }> }
  const result = data.tasks?.[0]?.result ?? []
  return result.map(item => item.id)
}

export async function getTaskResult(cfg: DataForSEOConfig, taskId: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl(cfg)}/business_data/google/reviews/task_get/${taskId}`, {
    method: "GET",
    headers: { Authorization: authHeader(cfg) },
  })

  if (!response.ok) {
    await throwForFailedResponse("task_get", response)
  }

  return response.json()
}
