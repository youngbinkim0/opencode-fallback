import type { Plugin } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { FallbackPluginConfig } from "./types"
import { DEFAULT_CONFIG } from "./constants"
import { fallbackRpc, type FallbackNotificationKind } from "./fallback-rpc"
import { logError, logInfo } from "./logger"

export interface FallbackNotifyInput {
	sessionID: string
	/** Model that failed, as "provider/id[#variant]". */
	from: string
	/** Model that was admitted, as "provider/id[#variant]". */
	to: string
	kind: FallbackNotificationKind
}

export interface FallbackNotifications {
	/** Never rejects. Callers notify once per admitted fallback. */
	notify(input: FallbackNotifyInput): Promise<void>
	/** Idempotent. Unregisters the RPC and drops later notifications. */
	dispose(): Promise<void>
}

/**
 * Registers the fallback notification RPC on the server. Call notify() once
 * per admitted fallback, or once per chosen compaction fallback.
 */
export async function registerFallbackNotifications(
	ctx: Plugin.Context,
	options: Pick<FallbackPluginConfig, "notify_on_fallback"> = ctx.options as Pick<FallbackPluginConfig, "notify_on_fallback">,
): Promise<FallbackNotifications> {
	const noop: FallbackNotifications = { notify: async () => {}, dispose: async () => {} }
	const enabled = options.notify_on_fallback ?? DEFAULT_CONFIG.notify_on_fallback
	if (!enabled) return noop

	let registration: RpcRegistration<typeof fallbackRpc>
	try {
		registration = await ctx.rpc.register(fallbackRpc, {})
	} catch (error) {
		logError("V2 fallback notifications unavailable", { directory: ctx.location.directory, error: String(error) })
		return noop
	}

	let disposed = false

	const notify = async (input: FallbackNotifyInput): Promise<void> => {
		if (disposed) return
		try {
			await registration.events.emit("notification", {
				id: crypto.randomUUID(),
				directory: ctx.location.directory,
				...(ctx.location.workspaceID ? { workspaceID: ctx.location.workspaceID } : {}),
				sessionID: input.sessionID,
				from: input.from,
				to: input.to,
				kind: input.kind,
			})
			logInfo("V2 fallback notification emitted", { sessionID: input.sessionID, from: input.from, to: input.to, kind: input.kind })
		} catch (error) {
			logError("V2 fallback notification failed", { sessionID: input.sessionID, error: String(error) })
		}
	}

	const dispose = async (): Promise<void> => {
		if (disposed) return
		disposed = true
		try {
			await registration.dispose()
		} catch (error) {
			logError("V2 fallback notification dispose failed", { error: String(error) })
		}
	}

	return { notify, dispose }
}
