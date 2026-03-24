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
	/** Polling interval in milliseconds (only used as fallback for streaming check) */
	pollIntervalMs?: number
}

/**
 * Helper to extract the session status type string from session.get() response.
 * OpenCode's SessionStatus is a discriminated union ({ type: "idle" } | ...) but
 * may also appear as a plain string.
 */
function getSessionStatusType(
	sessionData: Record<string, unknown> | undefined,
): string | undefined {
	const status = sessionData?.status
	if (!status) return undefined
	if (typeof status === "string") return status
	if (typeof status === "object" && status !== null && "type" in status) {
		return (status as { type?: string }).type
	}
	return undefined
}

/**
 * Wait for a child session to go idle using an event-driven approach.
 * Registers a resolver that handleSessionIdle triggers, with an immediate
 * status check to avoid missing events that fired before registration.
 */
function waitForSessionIdle(
	deps: HookDeps,
	sessionID: string,
	maxWaitMs: number,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false
		const settle = (result: boolean) => {
			if (settled) return
			settled = true
			// Clean up resolver
			const resolvers = deps.sessionIdleResolvers.get(sessionID)
			if (resolvers) {
				const idx = resolvers.indexOf(onIdle)
				if (idx >= 0) resolvers.splice(idx, 1)
				if (resolvers.length === 0) deps.sessionIdleResolvers.delete(sessionID)
			}
			resolve(result)
		}

		const onIdle = () => settle(true)

		// Register resolver for session.idle event
		let resolvers = deps.sessionIdleResolvers.get(sessionID)
		if (!resolvers) {
			resolvers = []
			deps.sessionIdleResolvers.set(sessionID, resolvers)
		}
		resolvers.push(onIdle)

		// Timeout — only fires if session.idle never comes
		const timer = setTimeout(() => settle(false), maxWaitMs)
		// Override settle to also clear timer
		const originalSettle = settle
		const settleWithCleanup = (result: boolean) => {
			clearTimeout(timer)
			originalSettle(result)
		}
		// Patch: use settleWithCleanup for the onIdle path too
		const idxSelf = resolvers.indexOf(onIdle)
		if (idxSelf >= 0) {
			resolvers[idxSelf] = () => settleWithCleanup(true)
		}

		// Immediate check: session may already be idle (race protection)
		deps.ctx.client.session.get({ path: { id: sessionID } })
			.then((sessionInfo) => {
				const statusType = getSessionStatusType(
					(sessionInfo?.data ?? sessionInfo) as Record<string, unknown> | undefined
				)
				if (statusType === "idle") {
					settleWithCleanup(true)
				}
			})
			.catch(() => {
				// Ignore — we'll rely on the event
			})
	})
}

/**
 * Wait for child session fallback to complete and return the assistant's
 * response text. Uses event-driven session.idle detection rather than polling.
 *
 * Returns null if the wait times out or no valid assistant response is found.
 *
 * Timeout behavior: maxWaitMs is the overall timeout. If the child has started
 * streaming (firstTokenReceived), we extend the timeout generously since the
 * model is making progress.
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

	// Phase 1: Wait for fallback dispatch to complete (retry flags to clear)
	// This is a short spin-wait since dispatch happens within milliseconds.
	while (deps.sessionRetryInFlight.has(childSessionID)) {
		if (Date.now() - startTime >= maxWaitMs) {
			logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} dispatch after ${maxWaitMs}ms`)
			return null
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
	}

	// Phase 2: Wait for the child session to go idle (model done generating).
	// Use event-driven approach — handleSessionIdle will resolve our waiter.
	const remainingMs = Math.max(1000, maxWaitMs - (Date.now() - startTime))

	// If child is already streaming, give it much more time
	const firstTokenReceived = deps.sessionFirstTokenReceived.get(childSessionID)
	const idleTimeoutMs = firstTokenReceived
		? Math.max(remainingMs, 120_000)  // At least 2 minutes if streaming
		: remainingMs

	const wentIdle = await waitForSessionIdle(deps, childSessionID, idleTimeoutMs)

	if (!wentIdle) {
		logInfo(`[subagent-sync] Timed out waiting for child ${childSessionID} after ${Date.now() - startTime}ms`)
		return null
	}

	// Phase 3: Extract the assistant response
	const result = await extractAssistantResponse(deps, childSessionID)
	if (result) {
		logInfo(`[subagent-sync] Got fallback result for ${childSessionID} (${Date.now() - startTime}ms)`)
		return result
	}

	logInfo(`[subagent-sync] Child ${childSessionID} idle but no assistant response found`)
	return null
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
