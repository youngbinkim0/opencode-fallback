import type { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { createBackgroundLease, startBackgroundSubagent, type NativeTool, type NativeToolContext, type NativeToolResult } from "./v2-background-task"

export { readV2ForegroundSubagentOutput } from "./v2-background-task"

/**
 * The V2 plugin owns retry/fallback state. This adapter only restores the
 * foreground tool's result after that owner has recovered the native child.
 */
export interface V2ForegroundTaskFallback {
	/** True for a tracked child eligible for or already running fallback. */
	ownsFallback(sessionID: string): boolean
	/** True after an observed user interruption, rather than an owned TTFT interrupt. */
	isCancelled?(sessionID: string): boolean
	/** Cancel the plugin-owned hand-off synchronously, even while the child is idle. */
	cancelFallback(sessionID: string): void
	/** Resolves with the completed child output after the owned fallback ends. */
	waitForFallback(sessionID: string, signal: AbortSignal): Promise<string | undefined>
}

/**
 * Wrap OpenCode's native V2 `subagent` tool without replacing its session,
 * permission, agent-selection, or cancellation behavior. The native tool
 * reports the child session ID through its supported progress callback before
 * starting the child prompt. When native execution fails, the V2 owner can
 * keep the foreground call pending through fallback and supply its result.
 *
 * Background calls detach through the final-outcome adapter; successful native
 * foreground calls and unowned child failures retain their native results.
 */
export async function installV2ForegroundTaskFallback(
	ctx: Plugin.Context,
	coordination: V2ForegroundTaskFallback,
): Promise<Registration> {
	let disposed = false
	// Bind this generation as the latest context for pending background jobs at this location.
	const releaseLease = createBackgroundLease(ctx, coordination)
	const registration = await ctx.tool.transform((editor) => {
		const nativeSubagent = editor.list().find((tool) => tool.name === "subagent" || tool.id === "subagent")
		if (!nativeSubagent) return
		editor.update(nativeSubagent.id, (tool) => {
			const native = tool as unknown as NativeTool
			const execute = native.execute
			native.execute = async (input, context) => {
				if ((input as { background?: unknown } | undefined)?.background === true) {
					return startBackgroundSubagent(ctx, coordination, { execute }, input, context)
				}

				let childSessionID: string | undefined
				const wrappedContext: NativeToolContext = {
					...context,
					async progress(update) {
						if (typeof update.sessionID === "string") childSessionID = update.sessionID
						await context.progress(update)
					},
				}

				try {
					return await execute(input, wrappedContext)
				} catch (error) {
					if (!childSessionID || !coordination.ownsFallback(childSessionID)) throw error
					const child = childSessionID
					const cancelChild = () => {
						coordination.cancelFallback(child)
						void ctx.session.interrupt({ sessionID: child, resume: false }).catch(() => {})
					}
					// The parent is already cancelled, so it cannot receive a recovered
					// result. Stop the owned child instead of letting it run unattended.
					if (context.signal.aborted) {
						cancelChild()
						throw error
					}
					let output: string | undefined
					context.signal.addEventListener("abort", cancelChild, { once: true })
					try {
						output = await coordination.waitForFallback(childSessionID, context.signal)
					} catch {
						// Preserve the native error if the independent fallback owner
						// cannot confirm a completed recovery.
						throw error
					} finally {
						context.signal.removeEventListener("abort", cancelChild)
					}
					if (context.signal.aborted || !output?.trim()) throw error
					const result = { sessionID: childSessionID, status: "completed" as const, output }
					return {
						output: result,
						content: `<subagent sessionID="${childSessionID}" state="completed">\n${output}\n</subagent>`,
						metadata: { sessionID: childSessionID, status: "completed" },
					} satisfies NativeToolResult
				}
			}
		})
	})
	return {
		dispose: async () => {
			if (disposed) return
			// Pending background jobs wait for the next binding; children are never
			// cancelled by a reload.
			disposed = true
			releaseLease()
			await registration.dispose()
		},
	}
}
