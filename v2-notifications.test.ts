import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { fallbackRpc } from "./fallback-rpc"
import { registerFallbackNotifications } from "./v2-notifications"

function fixture(options: {
	directory?: string
	workspaceID?: string
	options?: Record<string, unknown>
	registerError?: unknown
	failEmits?: number
	emitError?: unknown
	disposeError?: unknown
} = {}) {
	const registered: Array<{ definition: unknown; handlers: unknown }> = []
	const emitted: Array<[string, Record<string, unknown>]> = []
	let emitFailures = options.failEmits ?? 0
	let disposed = 0
	const ctx = {
		location: { directory: options.directory ?? "/repo/a", workspaceID: options.workspaceID },
		options: options.options ?? {},
		rpc: {
			async register(definition: unknown, handlers: unknown) {
				if (options.registerError) throw options.registerError
				registered.push({ definition, handlers })
				return {
					events: {
						async emit(name: string, data: Record<string, unknown>) {
							if (emitFailures > 0) {
								emitFailures--
								throw new Error("emit failed")
							}
							if (options.emitError) throw options.emitError
							emitted.push([name, data])
						},
					},
					async dispose() {
						disposed++
						if (options.disposeError) throw options.disposeError
					},
				}
			},
		},
	} as unknown as Plugin.Context
	return { ctx, registered, emitted, disposed: () => disposed }
}

const primary = { sessionID: "ses_1", from: "anthropic/a", to: "openai/b", kind: "primary" as const }

describe("fallback RPC definition", () => {
	test("declares a notification event on the opencode-fallback RPC", () => {
		expect(fallbackRpc.id).toBe("opencode-fallback")
		expect(Object.keys(fallbackRpc.events)).toEqual(["notification"])
		expect(fallbackRpc.events.notification.schema).toMatchObject({
			type: "object",
			required: expect.arrayContaining(["id", "directory", "sessionID", "from", "to", "kind"]),
		})
	})
})

describe("registerFallbackNotifications", () => {
	test("includes the workspace identity for clients whose public event location omits it", async () => {
		const f = fixture({ workspaceID: "workspace-a" })
		const notifications = await registerFallbackNotifications(f.ctx)
		await notifications.notify(primary)
		expect(f.emitted[0][1]).toMatchObject({ workspaceID: "workspace-a" })
	})
	test("registers the RPC once and emits a scoped primary fallback notification", async () => {
		const f = fixture()
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: true })
		await notifications.notify(primary)

		expect(f.registered).toHaveLength(1)
		expect(f.registered[0].definition).toBe(fallbackRpc)
		expect(f.registered[0].handlers).toEqual({})
		expect(f.emitted).toEqual([["notification", {
			id: expect.any(String),
			directory: "/repo/a",
			sessionID: "ses_1",
			from: "anthropic/a",
			to: "openai/b",
			kind: "primary",
		}]])
	})

	test("emits compaction fallbacks with their kind", async () => {
		const f = fixture()
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: true })
		await notifications.notify({ ...primary, kind: "compaction" })

		expect(f.emitted[0][1]).toMatchObject({ kind: "compaction" })
	})

	test("notify_on_fallback false registers nothing and never emits", async () => {
		const f = fixture()
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: false })
		await notifications.notify(primary)
		await notifications.dispose()

		expect(f.registered).toHaveLength(0)
		expect(f.emitted).toHaveLength(0)
		expect(f.disposed()).toBe(0)
	})

	test("reads notify_on_fallback from plugin options when no options are passed", async () => {
		const f = fixture({ options: { notify_on_fallback: false } })
		const notifications = await registerFallbackNotifications(f.ctx)
		await notifications.notify(primary)

		expect(f.registered).toHaveLength(0)
		expect(f.emitted).toHaveLength(0)
	})

	test("defaults to enabled when notify_on_fallback is unset", async () => {
		const f = fixture({ options: {} })
		const notifications = await registerFallbackNotifications(f.ctx)
		await notifications.notify(primary)

		expect(f.emitted).toHaveLength(1)
	})

	test("emits every notify call with a unique id, including repeated transitions", async () => {
		const f = fixture()
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: true })
		await notifications.notify(primary)
		await notifications.notify(primary)
		await notifications.notify({ ...primary, kind: "compaction" })
		await notifications.notify({ ...primary, kind: "compaction" })

		expect(f.emitted.map(([, data]) => [data.kind, data.id])).toEqual([
			["primary", expect.any(String)],
			["primary", expect.any(String)],
			["compaction", expect.any(String)],
			["compaction", expect.any(String)],
		])
		const ids = f.emitted.map(([, data]) => data.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	test("never rejects when emit fails", async () => {
		const f = fixture({ failEmits: 1 })
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: true })

		await expect(notifications.notify(primary)).resolves.toBeUndefined()
		expect(f.emitted).toHaveLength(0)

		await notifications.notify(primary)
		expect(f.emitted).toHaveLength(1)
	})

	test("returns a no-op notifier when RPC registration is unavailable", async () => {
		const f = fixture({ registerError: new Error("rpc unavailable") })
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: true })

		await expect(notifications.notify(primary)).resolves.toBeUndefined()
		await expect(notifications.dispose()).resolves.toBeUndefined()
		expect(f.emitted).toHaveLength(0)
	})

	test("dispose unregisters once and stops later notifications", async () => {
		const f = fixture()
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: true })
		await notifications.dispose()
		await notifications.dispose()
		await notifications.notify(primary)

		expect(f.disposed()).toBe(1)
		expect(f.emitted).toHaveLength(0)
	})

	test("dispose errors do not reject", async () => {
		const f = fixture({ disposeError: new Error("dispose failed") })
		const notifications = await registerFallbackNotifications(f.ctx, { notify_on_fallback: true })

		await expect(notifications.dispose()).resolves.toBeUndefined()
		expect(f.disposed()).toBe(1)
	})
})
