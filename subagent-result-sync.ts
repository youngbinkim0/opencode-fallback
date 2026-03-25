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

/** Maximum time to wait for a streaming child session (5 minutes). */
const STREAMING_MAX_WAIT_MS = 5 * 60 * 1000

/**
 * Wait for a child session to go idle using a hybrid approach:
 *
 * 1. Event-driven: registers a resolver that handleSessionIdle triggers
 * 2. Polling fallback: periodically checks session.get() status
 * 3. Streaming-aware: dynamically extends the deadline when the child
 *    starts generating tokens (firstTokenReceived becomes true)
 *
 * The polling fallback is essential because plugin reinitialization (e.g.
 * hot-reload) wipes the sessionIdleResolvers map, orphaning any registered
 * event-driven waiters.  The poller survives reinit because it uses the
 * SDK client directly.
 */
function waitForSessionIdle(
	deps: HookDeps,
	sessionID: string,
	baseMaxWaitMs: number,
	startTime: number,
	pollIntervalMs: number = 2000,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false
		let pollTimer: ReturnType<typeof setInterval> | undefined
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined
		let streamingDetected = false

		const settle = (result: boolean) => {
			if (settled) return
			settled = true
			// Clean up all timers
			if (pollTimer) clearInterval(pollTimer)
			if (timeoutTimer) clearTimeout(timeoutTimer)
			// Clean up resolver from map (search by reference identity)
			const resolvers = deps.sessionIdleResolvers.get(sessionID)
			if (resolvers) {
				const idx = resolvers.indexOf(onIdleRef)
				if (idx >= 0) resolvers.splice(idx, 1)
				if (resolvers.length === 0) deps.sessionIdleResolvers.delete(sessionID)
			}
			resolve(result)
		}

		// Stable reference for event-driven resolver (used for cleanup)
		const onIdleRef = () => settle(true)

		// Register resolver for session.idle event (primary path)
		let resolvers = deps.sessionIdleResolvers.get(sessionID)
		if (!resolvers) {
			resolvers = []
			deps.sessionIdleResolvers.set(sessionID, resolvers)
		}
		resolvers.push(onIdleRef)

		// Schedule initial timeout
		const scheduleTimeout = (ms: number) => {
			if (timeoutTimer) clearTimeout(timeoutTimer)
			timeoutTimer = setTimeout(() => settle(false), ms)
		}
		scheduleTimeout(baseMaxWaitMs)

		// Polling fallback — survives plugin reinit and detects streaming
		const pollStatus = () => {
			if (settled) return

			// ── Streaming-aware deadline extension ──
			// firstTokenReceived can become true at any point during the wait
			// (set by message-update-handler when the first assistant token
			// arrives).  When detected, extend the deadline generously —
			// the child is making progress and will eventually go idle.
			if (!streamingDetected && deps.sessionFirstTokenReceived.get(sessionID)) {
				streamingDetected = true
				const elapsed = Date.now() - startTime
				const newDeadline = Math.max(
					baseMaxWaitMs - elapsed,
					STREAMING_MAX_WAIT_MS - elapsed,
				)
				logInfo(`[subagent-sync] Child ${sessionID} started streaming, extending deadline by ${Math.round(newDeadline / 1000)}s`)
				scheduleTimeout(newDeadline)
			}

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
				.catch(() => {
					// Ignore — will retry on next poll
				})
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
 * - Streaming-aware timeout extension (child making progress → wait longer)
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
	// Hybrid: event-driven + polling + streaming-aware deadline extension.
	const remainingMs = Math.max(1000, maxWaitMs - (Date.now() - startTime))

	const wentIdle = await waitForSessionIdle(
		deps,
		childSessionID,
		remainingMs,
		startTime,
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
