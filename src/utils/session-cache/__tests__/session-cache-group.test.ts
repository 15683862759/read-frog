import type { ProxyResponse } from "@/types/proxy-fetch"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { SessionCache } from "../session-cache-group"

const storageHarness = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  const metadata = new Map<string, unknown>()
  const pendingKeyListReads: Array<(keys: string[] | null) => void> = []
  const writtenItemKeys: string[] = []
  let holdKeyListReads = false
  let armKeyListReadsAfterNextMutation = false

  return {
    pendingKeyListReads,
    writtenItemKeys,
    reset() {
      values.clear()
      metadata.clear()
      pendingKeyListReads.length = 0
      writtenItemKeys.length = 0
      holdKeyListReads = false
      armKeyListReadsAfterNextMutation = false
    },
    armKeyListReadsAfterNextMutation() {
      armKeyListReadsAfterNextMutation = true
    },
    releaseKeyListReads() {
      holdKeyListReads = false
      for (const resolve of pendingKeyListReads.splice(0)) {
        const current = values.get("session:cache_race__meta_keys")
        resolve(Array.isArray(current) ? structuredClone(current) : null)
      }
    },
    storage: {
      getItem: vi.fn<(key: string) => Promise<unknown>>(async (key: string) => {
        if (key === "session:cache_race__meta_keys" && holdKeyListReads) {
          return new Promise<string[] | null>((resolve) => {
            pendingKeyListReads.push(resolve)
          })
        }
        return values.has(key) ? structuredClone(values.get(key)) : null
      }),
      setItem: vi.fn<(key: string, value: unknown) => Promise<void>>(
        async (key: string, value: unknown) => {
          values.set(key, value)
          if (!key.endsWith("__meta_keys")) {
            writtenItemKeys.push(key)
          }
          if (armKeyListReadsAfterNextMutation) {
            armKeyListReadsAfterNextMutation = false
            holdKeyListReads = true
          }
        },
      ),
      removeItem: vi.fn<(key: string) => Promise<void>>(async (key: string) => {
        values.delete(key)
        if (armKeyListReadsAfterNextMutation) {
          armKeyListReadsAfterNextMutation = false
          holdKeyListReads = true
        }
      }),
      getMeta: vi.fn<(key: string) => Promise<unknown>>(async (key: string) => {
        return metadata.get(key) ?? null
      }),
      setMeta: vi.fn<(key: string, value: unknown) => Promise<void>>(
        async (key: string, value: unknown) => {
          metadata.set(key, value)
        },
      ),
      removeMeta: vi.fn<(key: string) => Promise<void>>(async (key: string) => {
        metadata.delete(key)
      }),
      removeItems: vi.fn<(items: Array<{ key: string }>) => Promise<void>>(
        async (items: Array<{ key: string }>) => {
          for (const { key } of items) {
            values.delete(key)
            metadata.delete(key)
          }
        },
      ),
    },
  }
})

function response(body: string): ProxyResponse {
  return { status: 200, statusText: "OK", headers: [], body }
}

describe("SessionCache", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageHarness.reset()
    Object.assign(storage, storageHarness.storage)
  })

  it("keeps every key when concurrent sets update the shared key list", async () => {
    const firstCache = new SessionCache("race")
    const secondCache = new SessionCache("race")

    storageHarness.armKeyListReadsAfterNextMutation()
    const firstSet = firstCache.set("GET", "https://example.com/first", response("first"))
    const secondSet = secondCache.set("GET", "https://example.com/second", response("second"))

    await vi.waitFor(() => expect(storageHarness.pendingKeyListReads).toHaveLength(1))
    expect(storageHarness.writtenItemKeys).toEqual([
      "session:cache_race_GET_https://example.com/first",
    ])
    storageHarness.releaseKeyListReads()
    await Promise.all([firstSet, secondSet])

    const trackedKeys = await storage.getItem<string[]>("session:cache_race__meta_keys")
    expect(trackedKeys).toHaveLength(2)
    expect(trackedKeys).toContain("session:cache_race_GET_https://example.com/first")
    expect(trackedKeys).toContain("session:cache_race_GET_https://example.com/second")

    expect(await firstCache.get("GET", "https://example.com/first")).toMatchObject({
      body: "first",
    })
    expect(await secondCache.get("GET", "https://example.com/second")).toMatchObject({
      body: "second",
    })
  })

  it("does not let a concurrent delete discard a newly tracked key", async () => {
    const cache = new SessionCache("race")
    await cache.set("GET", "https://example.com/old", response("old"))

    storageHarness.armKeyListReadsAfterNextMutation()
    const deleteOld = cache.delete("GET", "https://example.com/old")
    const setNew = cache.set("GET", "https://example.com/new", response("new"))

    await vi.waitFor(() => expect(storageHarness.pendingKeyListReads).toHaveLength(1))
    expect(storageHarness.writtenItemKeys).not.toContain(
      "session:cache_race_GET_https://example.com/new",
    )
    storageHarness.releaseKeyListReads()
    await Promise.all([deleteOld, setNew])

    const trackedKeys = await storage.getItem<string[]>("session:cache_race__meta_keys")
    expect(trackedKeys).toEqual(["session:cache_race_GET_https://example.com/new"])
    expect(await cache.get("GET", "https://example.com/new")).toMatchObject({ body: "new" })
  })
})
