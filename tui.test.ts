import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import plugin, { readTuiOptions } from "./tui"
import { describeFallback, fallbackRpc, isFallbackNotificationData } from "./fallback-rpc"

type Location = { directory: string; workspaceID?: string }
type Event = { type: string; data: unknown; location?: Location; created?: number }
type Handler = (event: Event) => Promise<void> | void
type Subscription = { definition: unknown; name: string; handler: Handler; removed: boolean; dead: boolean }

function fixture(options: {
	location?: Location | undefined
	defaultLocation?: Location
	options?: Record<string, unknown>
	memories?: Map<string, { value: object }>
	toastFailures?: number
	attention?: "ok" | "sync-throw" | "async-reject"
} = {}) {
	const subscriptions: Subscription[] = []
	const toasts: Array<Record<string, unknown>> = []
	const attention: Array<Record<string, unknown>> = []
	const memories = options.memories ?? new Map<string, { value: object }>()
	const failureHandlers = new Set<(event: { data: { sessionID: string }; created: number }) => void>()
	let toastFailures = options.toastFailures ?? 0
	const defaultLocation = options.defaultLocation ?? { directory: "/repo/a" }
	const ctx = {
		options: options.options ?? {},
		location: "location" in options ? options.location : { directory: "/repo/a" },
		data: {
			on(_type: string, handler: (event: { data: { sessionID: string }; created: number }) => void) {
				failureHandlers.add(handler)
				return () => { failureHandlers.delete(handler) }
			},
			location: {
				default: () => defaultLocation,
			},
		},
		client: {
			rpc(definition: unknown) {
				return {
					events: {
						on(name: string, handler: Handler) {
							const subscription: Subscription = { definition, name, handler, removed: false, dead: false }
							subscriptions.push(subscription)
							return () => {
								subscription.removed = true
							}
						},
					},
				}
			},
		},
		storage: {
			memory<Value extends object>(key: string, input: { initial: Value }) {
				if (!memories.has(key)) memories.set(key, { value: structuredClone(input.initial) })
				const value = memories.get(key)!.value as Value
				return [value, (mutation: (draft: Value) => void) => mutation(value)] as const
			},
		},
		ui: {
			toast: {
				show(input: Record<string, unknown>) {
					if (toastFailures > 0) {
						toastFailures--
						throw new Error("toast failed")
					}
					toasts.push(input)
				},
			},
		},
		attention: {
			notify(input: Record<string, unknown>) {
				if (options.attention === "sync-throw") throw new Error("sync attention failure")
				if (options.attention === "async-reject") return Promise.reject(new Error("async attention failure"))
				attention.push(input)
				return Promise.resolve({ ok: true })
			},
		},
	} as unknown as Plugin.Context
	return { ctx, subscriptions, toasts, attention, memories, failureHandlers }
}

function notification(overrides: Record<string, unknown> = {}) {
	return {
		id: "evt_1",
		directory: "/repo/a",
		sessionID: "ses_1",
		from: "anthropic/a",
		to: "openai/b",
		kind: "primary",
		...overrides,
	}
}

/**
 * Delivers an event like the host: awaits each live handler and records a
 * handler rejection as a dead subscription, which the host would drop.
 */
async function emit(subscriptions: Subscription[], data: unknown, location?: Location, created?: number) {
	for (const subscription of subscriptions) {
		if (subscription.removed || subscription.dead || subscription.name !== "notification") continue
		try {
			await subscription.handler({ type: "rpc.opencode-fallback.notification", data, location, created })
		} catch {
			subscription.dead = true
		}
	}
}

describe("shared notification payload", () => {
	test("validates optional workspace identity", () => {
		expect(isFallbackNotificationData(notification({ workspaceID: "workspace-a" }))).toBe(true)
		expect(isFallbackNotificationData(notification({ workspaceID: 42 }))).toBe(false)
	})

	test("filters workspace identity carried in the payload when the public event omits it", async () => {
		const f = fixture({ location: { directory: "/repo/a", workspaceID: "workspace-a" } })
		plugin.setup(f.ctx)
		await emit(f.subscriptions, notification({ workspaceID: "workspace-b" }), { directory: "/repo/a" })
		expect(f.toasts).toEqual([])
		await emit(f.subscriptions, notification({ workspaceID: "workspace-a" }), { directory: "/repo/a" })
		expect(f.toasts).toHaveLength(1)
	})
	test("describes primary and compaction fallbacks", () => {
		expect(describeFallback({ from: "a/one", to: "b/two", kind: "primary" })).toEqual({
			title: "Model fallback",
			message: "a/one -> b/two",
		})
		expect(describeFallback({ from: "a/one", to: "b/two", kind: "compaction" })).toEqual({
			title: "Compaction fallback",
			message: "a/one -> b/two",
		})
	})

	test("accepts only well-formed notification data", () => {
		expect(isFallbackNotificationData(notification())).toBe(true)
		expect(isFallbackNotificationData(notification({ kind: "other" }))).toBe(false)
		expect(isFallbackNotificationData(notification({ sessionID: "" }))).toBe(false)
		expect(isFallbackNotificationData(notification({ id: undefined }))).toBe(false)
		expect(isFallbackNotificationData(null)).toBe(false)
	})
})

describe("readTuiOptions", () => {
	test("defaults to toast only", () => {
		expect(readTuiOptions({})).toEqual({ notify_toast: true, notify_desktop: false, notify_sound: false })
	})

	test("ignores non-boolean values", () => {
		expect(readTuiOptions({ notify_toast: "no", notify_desktop: 1, notify_sound: true })).toEqual({
			notify_toast: true,
			notify_desktop: false,
			notify_sound: true,
		})
	})
})

describe("opencode-fallback TUI plugin", () => {
	test("restores a fallback toast overwritten by a late older native failure without repeating attention", async () => {
		const f = fixture({ options: { notify_desktop: true } })
		const dispose = plugin.setup(f.ctx) as () => void
		try {
			await emit(f.subscriptions, notification(), { directory: "/repo/a" }, 200)
			for (const handler of f.failureHandlers) handler({ data: { sessionID: "ses_1" }, created: 100 })
			// The built-in handler runs in the same event delivery and replaces the toast.
			f.ctx.ui.toast.show({ title: "Session failed", message: "old failure", variant: "error" })
			await Bun.sleep(10)
			expect(f.toasts.at(-1)?.title).toBe("Model fallback")
			expect(f.toasts).toHaveLength(3)
			expect(f.attention).toHaveLength(1)
		} finally { dispose() }
	})

	test("leaves newer native failures visible and cancels any queued restoration", async () => {
		const f = fixture()
		const dispose = plugin.setup(f.ctx) as () => void
		try {
			await emit(f.subscriptions, notification(), { directory: "/repo/a" }, 200)
			for (const handler of f.failureHandlers) handler({ data: { sessionID: "ses_1" }, created: 100 })
			for (const handler of f.failureHandlers) handler({ data: { sessionID: "ses_1" }, created: 300 })
			f.ctx.ui.toast.show({ title: "Session failed", message: "backup failed", variant: "error" })
			await Bun.sleep(10)
			expect(f.toasts.at(-1)?.title).toBe("Session failed")
			expect(f.toasts).toHaveLength(2)
		} finally { dispose() }
	})

	test("disposal removes the native failure listener and cancels queued toast restoration", async () => {
		const f = fixture()
		const dispose = plugin.setup(f.ctx) as () => void
		await emit(f.subscriptions, notification(), { directory: "/repo/a" }, 200)
		for (const handler of f.failureHandlers) handler({ data: { sessionID: "ses_1" }, created: 100 })
		dispose()
		await Bun.sleep(10)
		expect(f.failureHandlers.size).toBe(0)
		expect(f.toasts).toHaveLength(1)
	})

	test("keeps failures with missing or invalid timestamps visible", async () => {
		for (const created of [undefined, NaN]) {
			const f = fixture()
			const dispose = plugin.setup(f.ctx) as () => void
			try {
				await emit(f.subscriptions, notification(), { directory: "/repo/a" }, 200)
				for (const handler of f.failureHandlers) handler({ data: { sessionID: "ses_1" }, created: created as number })
				f.ctx.ui.toast.show({ title: "Session failed", message: "failure without timestamp", variant: "error" })
				await Bun.sleep(10)
				expect(f.toasts.at(-1)?.title).toBe("Session failed")
				expect(f.toasts).toHaveLength(2)
			} finally { dispose() }
		}
	})

	test("restores same-timestamp failures even when the built-in handler runs first", async () => {
		const f = fixture()
		const dispose = plugin.setup(f.ctx) as () => void
		try {
			await emit(f.subscriptions, notification(), { directory: "/repo/a" }, 200)
			f.ctx.ui.toast.show({ title: "Session failed", message: "same-millisecond failure", variant: "error" })
			for (const handler of f.failureHandlers) handler({ data: { sessionID: "ses_1" }, created: 200 })
			await Bun.sleep(10)
			expect(f.toasts.at(-1)?.title).toBe("Model fallback")
		} finally { dispose() }
	})

	test("exports a plain plugin definition with an id and setup", () => {
		expect(plugin.id).toBe("opencode-fallback")
		expect(typeof plugin.setup).toBe("function")
	})

	test("subscribes to the fallback RPC notification event", async () => {
		const f = fixture()
		await plugin.setup(f.ctx)

		expect(f.subscriptions).toHaveLength(1)
		expect(f.subscriptions[0].definition).toBe(fallbackRpc)
		expect(f.subscriptions[0].name).toBe("notification")
	})

	test("shows a warning toast scoped to the fallback session by default", async () => {
		const f = fixture()
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })

		expect(f.toasts).toEqual([{
			title: "Model fallback",
			message: "anthropic/a -> openai/b",
			variant: "warning",
			sessionID: "ses_1",
		}])
		expect(f.attention).toHaveLength(0)
	})

	test("ignores notifications from other project directories", async () => {
		const f = fixture({ location: { directory: "/repo/a" } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification({ directory: "/repo/other" }), { directory: "/repo/other" })

		expect(f.toasts).toHaveLength(0)
	})

	test("missing context.location filters with data.location.default()", async () => {
		const f = fixture({ location: undefined, defaultLocation: { directory: "/repo/a" } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await emit(f.subscriptions, notification({ id: "evt_2", directory: "/repo/other" }), { directory: "/repo/other" })

		expect(f.toasts).toHaveLength(1)
		expect(f.toasts[0]).toMatchObject({ sessionID: "ses_1" })
	})

	test("missing context.location and default location mismatch drops the event", async () => {
		const f = fixture({ location: undefined, defaultLocation: { directory: "/repo/b" } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })

		expect(f.toasts).toHaveLength(0)
	})

	test("uses payload directory when the event lacks location", async () => {
		const f = fixture({ location: { directory: "/repo/a" } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), undefined)
		await emit(f.subscriptions, notification({ id: "evt_2", directory: "/repo/other" }), undefined)

		expect(f.toasts).toHaveLength(1)
	})

	test("event location directory overrides a matching payload directory", async () => {
		const f = fixture({ location: { directory: "/repo/a" } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification({ directory: "/repo/a" }), { directory: "/repo/other" })

		expect(f.toasts).toHaveLength(0)
	})

	test("drops events whose workspaceID differs from the active TUI workspace", async () => {
		const f = fixture({ location: { directory: "/repo/a", workspaceID: "wsp_1" } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a", workspaceID: "wsp_2" })
		await emit(f.subscriptions, notification({ id: "evt_2" }), { directory: "/repo/a", workspaceID: "wsp_1" })

		expect(f.toasts).toHaveLength(1)
		expect(f.toasts[0]).toMatchObject({ sessionID: "ses_1" })
	})

	test("does not compare workspaces when either side has none", async () => {
		const f = fixture({ location: { directory: "/repo/a" } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a", workspaceID: "wsp_2" })

		expect(f.toasts).toHaveLength(1)
	})

	test("shows each notification id once", async () => {
		const f = fixture()
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await emit(f.subscriptions, notification({ id: "evt_2" }), { directory: "/repo/a" })

		expect(f.toasts).toHaveLength(2)
	})

	test("ignores malformed payloads", async () => {
		const f = fixture()
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, { sessionID: "ses_1" }, { directory: "/repo/a" })
		await emit(f.subscriptions, notification({ kind: "unknown" }), { directory: "/repo/a" })

		expect(f.toasts).toHaveLength(0)
	})

	test("notify_toast false suppresses the toast", async () => {
		const f = fixture({ options: { notify_toast: false } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })

		expect(f.toasts).toHaveLength(0)
		expect(f.attention).toHaveLength(0)
	})

	test("desktop and sound alerts are opt-in and only fire when blurred", async () => {
		const f = fixture({ options: { notify_desktop: true, notify_sound: true } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await Promise.resolve()

		expect(f.toasts).toHaveLength(1)
		expect(f.attention).toEqual([{
			title: "Model fallback",
			message: "anthropic/a -> openai/b",
			notification: { when: "blurred" },
			sound: { name: "default", when: "blurred" },
		}])
	})

	test("desktop alert alone leaves sound disabled", async () => {
		const f = fixture({ options: { notify_desktop: true } })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await Promise.resolve()

		expect(f.attention[0]).toMatchObject({ notification: { when: "blurred" }, sound: false })
	})

	test("hot reload: a second setup shares the memory seen list so each id shows once", async () => {
		const memories = new Map<string, { value: object }>()
		const first = fixture({ memories })
		const cleanupFirst = await plugin.setup(first.ctx)
		const second = fixture({ memories })
		const cleanupSecond = await plugin.setup(second.ctx)

		await emit(first.subscriptions, notification(), { directory: "/repo/a" })
		await emit(second.subscriptions, notification(), { directory: "/repo/a" })
		expect(first.toasts.length + second.toasts.length).toBe(1)

		await emit(second.subscriptions, notification({ id: "evt_2" }), { directory: "/repo/a" })
		expect(first.toasts.length + second.toasts.length).toBe(2)

		if (typeof cleanupFirst === "function") await cleanupFirst()
		if (typeof cleanupSecond === "function") await cleanupSecond()
	})

	test("a failed later setup does not disable an earlier live subscription", async () => {
		const memories = new Map<string, { value: object }>()
		const first = fixture({ memories })
		await plugin.setup(first.ctx)
		const second = fixture({ memories })
		second.ctx.client.rpc = () => {
			throw new Error("rpc unavailable")
		}
		await expect(Promise.resolve().then(() => plugin.setup(second.ctx))).rejects.toThrow("rpc unavailable")

		await emit(first.subscriptions, notification(), { directory: "/repo/a" })
		expect(first.toasts).toHaveLength(1)
	})

	test("cleanup unsubscribes from the notification event", async () => {
		const f = fixture()
		const cleanup = await plugin.setup(f.ctx)
		if (typeof cleanup === "function") await cleanup()

		expect(f.subscriptions[0].removed).toBe(true)
	})

	test("a failing toast does not stop later notifications", async () => {
		const f = fixture({ toastFailures: 1 })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await emit(f.subscriptions, notification({ id: "evt_2" }), { directory: "/repo/a" })

		expect(f.subscriptions[0].dead).toBe(false)
		expect(f.toasts).toHaveLength(1)
		expect(f.toasts[0]).toMatchObject({ sessionID: "ses_1" })
	})

	test("a synchronously throwing attention notifier does not kill the subscription", async () => {
		const f = fixture({ options: { notify_desktop: true }, attention: "sync-throw" })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await emit(f.subscriptions, notification({ id: "evt_2" }), { directory: "/repo/a" })

		expect(f.subscriptions[0].dead).toBe(false)
		expect(f.toasts).toHaveLength(2)
	})

	test("an asynchronously rejecting attention notifier does not kill the subscription", async () => {
		const f = fixture({ options: { notify_desktop: true }, attention: "async-reject" })
		await plugin.setup(f.ctx)
		await emit(f.subscriptions, notification(), { directory: "/repo/a" })
		await emit(f.subscriptions, notification({ id: "evt_2" }), { directory: "/repo/a" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(f.subscriptions[0].dead).toBe(false)
		expect(f.toasts).toHaveLength(2)
	})
})
