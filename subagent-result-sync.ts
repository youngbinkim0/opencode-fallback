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
 * Wait for a child session to go idle using a hybrid approach:
 *
 * 1. Event-driven: registers a resolver that handleSessionIdle triggers
 * 2. Polling fallback: periodically checks session.get() status
 * 3. Activity-aware: resets the timeout whenever a message.updated is
 *    received for the child session (tracked via sessionLastMessageTime)
 *
 * The polling fallback is essential because plugin reinitialization (e.g.
 * hot-reload) wipes the sessionIdleResolvers map, orphaning any registered
 * event-driven waiters.  The poller survives reinit because it uses the
 * SDK client directly.
 *
 * Timeout behavior: the inactivityMs timeout resets every time we see a
 * new message.updated for the child.  As long as messages keep arriving,
 * the child is making progress and we keep waiting.  We only time out
 * after inactivityMs of silence.
 */
function waitForSessionIdle(
	deps: HookDeps,
	sessionID: string,
	inactivityMs: number,
	pollIntervalMs: number = 2000,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false
		let pollTimer: ReturnType<typeof setInterval> | undefined
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined
		let lastSeenMessageTime = deps.sessionLastMessageTime.get(sessionID) ?? Date.now()

		const settle = (result: boolean) => {
			if (settled) return
			settled = true
			if (pollTimer) clearInterval(pollTimer)
			if (timeoutTimer) clearTimeout(timeoutTimer)
			const resolvers = deps.sessionIdleResolvers.get(sessionID)
			if (resolvers) {
				const idx = resolvers.indexOf(onIdleRef)
				if (idx >= 0) resolvers.splice(idx, 1)
				if (resolvers.length === 0) deps.sessionIdleResolvers.delete(sessionID)
			}
			resolve(result)
		}

		const onIdleRef = () => settle(true)

		// Register resolver for session.idle event (primary path)
		let resolvers = deps.sessionIdleResolvers.get(sessionID)
		if (!resolvers) {
			resolvers = []
			deps.sessionIdleResolvers.set(sessionID, resolvers)
		}
		resolvers.push(onIdleRef)

		// Schedule the inactivity timeout
		const resetTimeout = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer)
			timeoutTimer = setTimeout(() => settle(false), inactivityMs)
		}
		resetTimeout()

		// Polling: check for idle status AND for new message activity
		const pollStatus = () => {
			if (settled) return

			// Check if new message.updated events arrived since last poll.
			// If so, the child is still working — reset the timeout.
			const currentMessageTime = deps.sessionLastMessageTime.get(sessionID)
			if (currentMessageTime && currentMessageTime > lastSeenMessageTime) {
				lastSeenMessageTime = currentMessageTime
				resetTimeout()
			}

			// Also poll session.get() as a fallback for idle detection
			deps.ctx.client.session.get({ path: { id: sessionID } })
				.then((sessionInfo) => {
					if (settled) return
					const statusType = getSessionStatusType(
						(sessionInfo?.data ?? sessionInfo) as Record<string, unknown> | undefined
					)
					if (statusType === "idle") {
						logInfo(`[subagent-sync] Polling detected child ${sessionID} idle`)
						settle(true)
					}
				})
				.catch(() => {})
		}

		// Immediate check + start periodic polling
		pollStatus()
		pollTimer = setInterval(pollStatus, pollIntervalMs)
	})
}

/**
 * Wait for child session fallback to complete and return the assistant's
 * response text.  Uses a hybrid approach:
 *
 * - Event-driven session.idle detection (fastest path)
 * - Polling fallback via session.get() (survives plugin reinit)
 * - Activity-aware timeout: resets every time a message.updated is received
 *   for the child, so active sessions never time out prematurely
 *
 * Returns null if the wait times out or no valid assistant response is found.
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
	// Hybrid: event-driven idle resolver + polling via session.get().
	// The timeout resets every time a message.updated is received for the
	// child, so actively streaming sessions never time out prematurely.
	const remainingMs = Math.max(1000, maxWaitMs - (Date.now() - startTime))

	const wentIdle = await waitForSessionIdle(
		deps,
		childSessionID,
		remainingMs,
		pollIntervalMs,
	)

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
