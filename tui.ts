// Type-only import: the runtime entry of @opencode/plugin/tui pulls in solid-js.
import type { Plugin } from "@opencode/plugin/tui"
import { describeFallback, fallbackRpc, isFallbackNotificationData, type FallbackNotificationData } from "./fallback-rpc"
import { logInfo, logError } from "./logger"

export interface FallbackTuiOptions {
	/** Show an in-app toast. Default: true. */
	notify_toast: boolean
	/** Desktop notification, only while the terminal is blurred. Default: false. */
	notify_desktop: boolean
	/** Sound alert, only while the terminal is blurred. Default: false. */
	notify_sound: boolean
}

const TUI_DEFAULTS: FallbackTuiOptions = { notify_toast: true, notify_desktop: false, notify_sound: false }
const STATE_KEY = "opencode-fallback:notifications"
const SEEN_LIMIT = 100

export function readTuiOptions(options: Readonly<Record<string, unknown>>): FallbackTuiOptions {
	const read = (key: keyof FallbackTuiOptions): boolean => {
		const value = options[key]
		return typeof value === "boolean" ? value : TUI_DEFAULTS[key]
	}
	return { notify_toast: read("notify_toast"), notify_desktop: read("notify_desktop"), notify_sound: read("notify_sound") }
}

type Context = Plugin.Context

function present(context: Context, options: FallbackTuiOptions, data: FallbackNotificationData) {
	const { title, message } = describeFallback(data)
	if (options.notify_toast) {
		try {
			context.ui.toast.show({ title, message, variant: "warning", sessionID: data.sessionID })
			logInfo("V2 fallback TUI toast submitted", { sessionID: data.sessionID, title })
		} catch (error) {
			// A UI failure must not stop later notifications.
			logError("V2 fallback TUI toast failed", { sessionID: data.sessionID, error: String(error) })
		}
	}
	if (options.notify_desktop || options.notify_sound) {
		// Async wrapper turns sync throws into rejections, so both are caught here.
		const alert = async () => {
			await context.attention.notify({
				title,
				message,
				notification: options.notify_desktop ? { when: "blurred" } : false,
				sound: options.notify_sound ? { name: "default", when: "blurred" } : false,
			})
		}
		void alert().catch(() => {})
	}
}

const plugin: Plugin.Definition = {
	id: "opencode-fallback",
	setup(context) {
		const options = readTuiOptions(context.options)
		logInfo("V2 fallback TUI initialized", { directory: (context.location ?? context.data.location.default()).directory, ...options })
		const [state, mutate] = context.storage.memory(STATE_KEY, { initial: { seen: [] as string[] } })
		// Native failure toasts and RPC notifications use independent event streams.
		// If an older failure arrives late, restore the fallback toast after the
		// built-in notification handler runs. Never hide a newer failure or repeat attention alerts.
		const recent = new Map<string, { data: FallbackNotificationData; created: number; expiry: ReturnType<typeof setTimeout>; restore?: ReturnType<typeof setTimeout> }>()
		const forget = (sessionID: string) => {
			const item = recent.get(sessionID)
			if (!item) return
			clearTimeout(item.expiry)
			clearTimeout(item.restore)
			recent.delete(sessionID)
		}
		const stopFailures = context.data.on("session.execution.failed", (event) => {
			const item = recent.get(event.data.sessionID)
			if (!item) return
			if (!Number.isFinite(event.created) || event.created > item.created) {
				forget(event.data.sessionID)
				return
			}
			clearTimeout(item.restore)
			item.restore = setTimeout(() => {
				if (recent.get(event.data.sessionID) !== item) return
				present(context, { ...options, notify_desktop: false, notify_sound: false }, item.data)
				logInfo("V2 fallback TUI toast restored after older failure", { sessionID: event.data.sessionID, failureCreated: event.created, notificationCreated: item.created })
			}, 0)
		})
		const unsubscribe = context.client.rpc(fallbackRpc).events.on("notification", async (event) => {
			// Never reject: a rejected handler could end the subscription.
			try {
				const data = event.data
				if (!isFallbackNotificationData(data)) return
				// Use the active TUI location, falling back to the default location when unset.
				const here = context.location ?? context.data.location.default()
				// The server stamps event.location; payload directory is used when it is absent.
				const directory = event.location?.directory ?? data.directory
				if (directory !== here.directory) {
					logInfo("V2 fallback TUI notification ignored for another directory", { sessionID: data.sessionID, directory, currentDirectory: here.directory })
					return
				}
				// The public event type omits workspaceID, so read it defensively and compare only when both sides have one.
				const workspaceID: unknown = (event.location as { workspaceID?: unknown } | undefined)?.workspaceID ?? data.workspaceID
				if (typeof workspaceID === "string" && here.workspaceID && workspaceID !== here.workspaceID) {
					logInfo("V2 fallback TUI notification ignored for another workspace", { sessionID: data.sessionID, workspaceID, currentWorkspaceID: here.workspaceID })
					return
				}
				// Shared memory dedupes hot-reloaded subscriptions: each id is shown once.
				if (state.seen.includes(data.id)) return
				mutate((draft) => {
					draft.seen.push(data.id)
					if (draft.seen.length > SEEN_LIMIT) draft.seen.splice(0, draft.seen.length - SEEN_LIMIT)
				})
				present(context, options, data)
				if (options.notify_toast && Number.isFinite(event.created)) {
					forget(data.sessionID)
					const item = { data, created: event.created, expiry: setTimeout(() => forget(data.sessionID), 5000) }
					recent.set(data.sessionID, item)
				}
				logInfo("V2 fallback TUI notification handled", { sessionID: data.sessionID, from: data.from, to: data.to, ...options })
			} catch (error) {
				// Swallowed: the subscription must keep receiving later events.
				logError("V2 fallback TUI notification failed", { error: String(error) })
			}
		})
		return () => {
			unsubscribe()
			stopFailures()
			for (const sessionID of recent.keys()) forget(sessionID)
		}
	},
}

export default plugin
