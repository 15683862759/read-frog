import { beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { SessionCacheGroupRegistry } from "../session-cache-group-registry"

const REGISTRY_KEY = "session:__system_cache_registry"

const storageHarness = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  const pendingRegistryReads: Array<(registry: string[] | null) => void> = []
  let holdRegistryReads = false

  return {
    pendingRegistryReads,
    reset() {
      values.clear()
      pendingRegistryReads.length = 0
      holdRegistryReads = false
    },
    holdRegistryReads() {
      holdRegistryReads = true
    },
    setRegistry(groups: string[]) {
      values.set(REGISTRY_KEY, groups)
    },
    releaseRegistryReads() {
      holdRegistryReads = false
      for (const resolve of pendingRegistryReads.splice(0)) {
        const current = values.get(REGISTRY_KEY)
        resolve(Array.isArray(current) ? structuredClone(current) : null)
      }
    },
    storage: {
      getItem: vi.fn<(key: string) => Promise<unknown>>(async (key: string) => {
        if (key === REGISTRY_KEY && holdRegistryReads) {
          return new Promise<string[] | null>((resolve) => {
            pendingRegistryReads.push(resolve)
          })
        }
        return values.has(key) ? structuredClone(values.get(key)) : null
      }),
      setItem: vi.fn<(key: string, value: unknown) => Promise<void>>(
        async (key: string, value: unknown) => {
          values.set(key, value)
        },
      ),
      removeItem: vi.fn<(key: string) => Promise<void>>(async (key: string) => {
        values.delete(key)
      }),
      removeItems: vi.fn<(items: Array<{ key: string }>) => Promise<void>>(
        async (items: Array<{ key: string }>) => {
          for (const { key } of items) {
            values.delete(key)
          }
        },
      ),
    },
  }
})

describe("SessionCacheGroupRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageHarness.reset()
    Object.assign(storage, storageHarness.storage)
  })

  it("keeps every group when concurrent registrations update the registry", async () => {
    storageHarness.holdRegistryReads()
    const firstRegistration = SessionCacheGroupRegistry.registerCacheGroup("first")
    const secondRegistration = SessionCacheGroupRegistry.registerCacheGroup("second")

    await vi.waitFor(() => expect(storageHarness.pendingRegistryReads).toHaveLength(1))
    storageHarness.releaseRegistryReads()
    await Promise.all([firstRegistration, secondRegistration])

    expect(await SessionCacheGroupRegistry.getAllCacheGroup()).toEqual(["first", "second"])
  })

  it("does not discard a group registered while another group is removed", async () => {
    storageHarness.setRegistry(["removed"])
    storageHarness.holdRegistryReads()
    const removeOld = SessionCacheGroupRegistry.removeCacheGroup("removed")

    await vi.waitFor(() => expect(storageHarness.pendingRegistryReads).toHaveLength(1))
    const registerNew = SessionCacheGroupRegistry.registerCacheGroup("added")

    storageHarness.releaseRegistryReads()
    await Promise.all([removeOld, registerNew])

    expect(await SessionCacheGroupRegistry.getAllCacheGroup()).toEqual(["added"])
  })

  it("keeps a group registered while all cache groups are clearing", async () => {
    storageHarness.setRegistry(["clearing"])
    storageHarness.holdRegistryReads()
    const clearAll = SessionCacheGroupRegistry.clearAllCacheGroup()

    await vi.waitFor(() => expect(storageHarness.pendingRegistryReads).toHaveLength(1))
    const registerNew = SessionCacheGroupRegistry.registerCacheGroup("added")
    storageHarness.releaseRegistryReads()
    await Promise.all([clearAll, registerNew])

    expect(await SessionCacheGroupRegistry.getAllCacheGroup()).toEqual(["added"])
  })
})
