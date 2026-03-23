import type { HookDeps } from "./types"
import { logInfo } from "./logger"

/**
 * Detect whether a task tool output contains an empty <task_result> tag,
 * indicating the child session returned no content (likely due to a model
 * failure that triggered fallback).
 */
export function isEmptyTaskResult(output: string): boolean {
	return /<task_result>\s*<\/task_result>/.test(output)
}

/**
 * Extract the child session ID from task tool output.
 * Format: `task_id: ses_XXXXX (for resuming...)`
 */
const TASK_ID_REGEX = /task_id:\s*(ses_[a-zA-Z0-9]+)/

export function extractChildSessionID(output: string): string | null {
	if (!output) return null
	const match = output.match(TASK_ID_REGEX)
	return match ? match[1] : null
}

export interface WaitOptions {
	/** Maximum time to wait in milliseconds */
	maxWaitMs?: number
	/** Polling interval in milliseconds */
	pollIntervalMs?: number
}

/**
 * Poll the child session until its fallback completes and return the
 * assistant's response text. Returns null if the wait times out or
 * no valid assistant response is found.
 *
 * Timeout behavior: the maxWaitMs timeout only applies when the child
 * session is NOT actively generating tokens. If the child is streaming
 * (status "active", not in retry/awaiting sets, first token received),
 * we keep waiting indefinitely — the child is making progress and will
 * eventually go idle.
 */
export async function waitForChildFallbackResult(
	deps: HookDeps,
	childSessionID: string,
	options?: WaitOptions,
): Promise<string | null> {
	const maxWaitMs = options?.maxWaitMs ?? Math.min((deps.config.timeout_seconds || 120) * 1000, 120_000)
	const pollIntervalMs = options?.pollIntervalMs ?? 500
	const startTime = Date.now()

	logInfo(`[subagent-sync] Waiting for child ${childSessionID} fallback result (max ${maxWaitMs}ms idle timeout)`)

	while (true) {
		const inFlight = deps.sessionRetryInFlight.has(childSessionID)
		const awaiting = deps.sessionAwaitingFallbackResult.has(childSessionID)

		// Check if child is actively streaming tokens — this takes priority
		// over all other checks. A child can be in sessionAwaitingFallbackResult
		// AND streaming simultaneously (the "awaiting" flag stays set until a
		// visible final response is detected by message-update-handler).
		const firstTokenReceived = deps.sessionFirstTokenReceived.get(childSessionID)
		if (firstTokenReceived) {
			// Child has started generating tokens — keep waiting regardless
			// of timeout.
			if (!inFlight && !awaiting) {
				// Both flags cleared — message-update-handler has seen the
				// final response. Try to extract it now. The session may still
				// be "active" (tool calls after text generation) but the
				// assistant text is already available in messages.
				try {
					const result = await extractAssistantResponse(deps, childSessionID)
					if (result) {
						logInfo(`[subagent-sync] Got fallback result for ${childSessionID} (${Date.now() - startTime}ms)`)
						return result
					}
					// No text yet — check if session is idle (exhausted chain)
					const sessionInfo = await deps.ctx.client.session.get({ path: { id: childSessionID } })
					const status = sessionInfo?.data?.status as string | undefined
					if (status === "idle") {
						logInfo(`[subagent-sync] Child ${childSessionID} idle but no assistant response found`)
						return null
					}
				} catch (err) {
					logInfo(`[subagent-sync] Error checking child session: ${err}`)
				}
			}
			// Still streaming or still in retry — keep waiting with no timeout
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
			continue
		}

		if (!inFlight && !awaiting) {
			// No first token yet, but flags are clear — check session status
			try {
				const sessionInfo = await deps.ctx.client.session.get({ path: { id: childSessionID } })
				const status = sessionInfo?.data?.status as string | undefined

				if (status === "idle") {
					// Session finished — extract the response
					const result = await extractAssistantResponse(deps, childSessionID)
					if (result) {
						logInfo(`[subagent-sync] Got fallback result for ${childSessionID} (${Date.now() - startTime}ms)`)
						return result
					}
					// Idle but no assistant message — fallback chain may have been exhausted
					logInfo(`[subagent-sync] Child ${childSessionID} idle but no assistant response found`)
					return null
				}
			} catch (err) {
				logInfo(`[subagent-sync] Error checking child session: ${err}`)
			}
		}

		// Enforce timeout only when child has NOT started streaming
		if (Date.now() - startTime >= maxWaitMs) {
			logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} after ${maxWaitMs}ms`)
			return null
		}

		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
	}
}

/**
 * Read the child session's messages and extract the last assistant
 * message's text content.
 */
async function extractAssistantResponse(
	deps: HookDeps,
	childSessionID: string,
): Promise<string | null> {
	try {
		const msgs = await deps.ctx.client.session.messages({
			path: { id: childSessionID },
			query: { directory: deps.ctx.directory },
		})

		if (!msgs.data || msgs.data.length === 0) return null

		// Find the last assistant message
		const lastAssistant = [...msgs.data].reverse().find(
			(m) => m.info?.role === "assistant",
		)

		if (!lastAssistant?.parts) return null

		// Concatenate all text parts
		const textParts = lastAssistant.parts
			.filter((p) => p.type === "text" && p.text)
			.map((p) => p.text!)

		if (textParts.length === 0) return null

		return textParts.join("")
	} catch (err) {
		logInfo(`[subagent-sync] Error reading child messages: ${err}`)
		return null
	}
}
