import type { Rpc } from "@opencode/plugin/rpc"

/**
 * Shared by the server plugin (ctx.rpc.register) and the TUI companion
 * (client.rpc(...).events.on). Keep this module free of server-only or
 * UI-only imports so both bundles can load it.
 *
 * Type-only import: the definition is a plain literal, so no runtime
 * dependency on the RPC schema package is pulled in.
 */
export const FALLBACK_RPC_ID = "opencode-fallback"

export type FallbackNotificationKind = "primary" | "compaction"

/** Event data. The server stamps `location` on RPC events; `directory` is a fallback. */
export type FallbackNotificationData = {
	/** Unique per emitted notification; used by the TUI to show each event once. */
	id: string
	/** Project directory of the emitting plugin. */
	directory: string
	workspaceID?: string
	sessionID: string
	from: string
	to: string
	kind: FallbackNotificationKind
}

export const fallbackRpc = {
	id: FALLBACK_RPC_ID,
	methods: {},
	events: {
		notification: {
			schema: {
				type: "object",
				required: ["id", "directory", "sessionID", "from", "to", "kind"],
				properties: {
					id: { type: "string" },
		directory: { type: "string" },
		workspaceID: { type: "string" },
					sessionID: { type: "string" },
					from: { type: "string" },
					to: { type: "string" },
					kind: { type: "string", enum: ["primary", "compaction"] },
				},
			},
		},
	},
} as const satisfies Rpc.PortableDefinition

export function isFallbackNotificationData(value: unknown): value is FallbackNotificationData {
	if (!value || typeof value !== "object") return false
	const data = value as Record<string, unknown>
	const strings = ["id", "directory", "sessionID", "from", "to"] as const
	return strings.every((key) => typeof data[key] === "string" && data[key] !== "") &&
		(data.workspaceID === undefined || typeof data.workspaceID === "string") &&
		(data.kind === "primary" || data.kind === "compaction")
}

export function describeFallback(data: Pick<FallbackNotificationData, "from" | "to" | "kind">): { title: string; message: string } {
	return {
		title: data.kind === "compaction" ? "Compaction fallback" : "Model fallback",
		message: `${data.from} -> ${data.to}`,
	}
}
