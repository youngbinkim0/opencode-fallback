import type { HookDeps, MessagePart } from "./types"
import { logInfo, logError } from "./logger"
import { getFallbackModelsForSession, resolveAgentForSession } from "./config-reader"
import { prepareFallback } from "./fallback-state"
import { replayWithDegradation } from "./message-replay"

const SESSION_TTL_MS = 30 * 60 * 1000

declare function setTimeout(
	callback: () => void | Promise<void>,
	delay?: number
): ReturnType<typeof globalThis.setTimeout>
declare function clearTimeout(timeout: ReturnType<typeof globalThis.setTimeout>): void

// Delay after abort to let OpenCode's session-level abort propagation settle.
// Without this, a promptAsync sent immediately after abort can itself be aborted
// because OpenCode's abort is session-wide and takes time to fully propagate.
const POST_ABORT_DELAY_MS = 150

export function createAutoRetryHelpers(deps: HookDeps) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
		sessionFallbackTimeouts,
	} = deps

	const abortSessionRequest = async (sessionID: string, source: string): Promise<void> => {
		try {
			await ctx.client.session.abort({ path: { id: sessionID } })
			deps.sessionSelfAbortTimestamp.set(sessionID, Date.now())
			logInfo(`Aborted in-flight session request (${source})`, { sessionID })
		} catch (error) {
			logError(`Failed to abort in-flight session request (${source})`, {
				sessionID,
				error: String(error),
			})
		}
	}

	const clearSessionFallbackTimeout = (sessionID: string) => {
		const timer = sessionFallbackTimeouts.get(sessionID)
		if (timer) {
			clearTimeout(timer)
			sessionFallbackTimeouts.delete(sessionID)
		}
	}

	const scheduleSessionFallbackTimeout = (sessionID: string, resolvedAgent?: string) => {
		clearSessionFallbackTimeout(sessionID)

		const timeoutMs = config.timeout_seconds * 1000
		if (timeoutMs <= 0) return

		const timer = setTimeout(async () => {
			sessionFallbackTimeouts.delete(sessionID)

			// TTFT: if first token has been received, model is streaming — don't abort
			if (deps.sessionFirstTokenReceived.get(sessionID)) {
				logInfo("Timeout fired but first token already received, skipping abort", {
					sessionID,
				})
				return
			}

			const state = sessionStates.get(sessionID)
			if (!state) return

			if (sessionRetryInFlight.has(sessionID)) {
				logInfo("Overriding in-flight retry due to session timeout", { sessionID })
			}

			await abortSessionRequest(sessionID, "session.timeout")

			if (state.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}

			const fallbackModels = getFallbackModelsForSession(
				sessionID,
				resolvedAgent,
				deps.agentConfigs,
				deps.globalFallbackModels
			)
			if (fallbackModels.length === 0) return

			logInfo("Session fallback timeout reached", {
				sessionID,
				timeoutSeconds: config.timeout_seconds,
				currentModel: state.currentModel,
			})

			// Timeout callback manages its own lock lifecycle
			sessionRetryInFlight.add(sessionID)
			try {
				const result = prepareFallback(sessionID, state, fallbackModels, config)
				if (result.success && result.newModel) {
					await autoRetryWithFallback(
						sessionID,
						result.newModel,
						resolvedAgent,
						"session.timeout"
					)
				}
			} finally {
				sessionRetryInFlight.delete(sessionID)
			}
		}, timeoutMs)

		sessionFallbackTimeouts.set(sessionID, timer)
	}

	const autoRetryWithFallback = async (
		sessionID: string,
		newModel: string,
		resolvedAgent: string | undefined,
		source: string
	): Promise<void> => {
		// Guard: if the state has already been advanced past this model by
		// a concurrent handler (race between message.updated / session.error /
		// session.status), skip this retry — the other handler owns it now.
		const preCheckState = sessionStates.get(sessionID)
		if (preCheckState && preCheckState.currentModel !== newModel) {
			logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, wanted ${newModel}`, {
				sessionID,
				staleModel: newModel,
				currentModel: preCheckState.currentModel,
			})
			return
		}

		const modelParts = newModel.split("/")
		if (modelParts.length < 2) {
			logInfo(`Invalid model format (missing provider prefix): ${newModel}`)
			const state = sessionStates.get(sessionID)
			if (state?.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}
			return
		}

		const fallbackModelObj = {
			providerID: modelParts[0],
			modelID: modelParts.slice(1).join("/"),
		}

		await abortSessionRequest(sessionID, `pre-fallback.${source}`)

		// Wait for OpenCode's session-level abort to fully propagate.
		// Without this delay, the promptAsync below can be caught by the
		// still-propagating abort and receive a spurious MessageAbortedError.
		await new Promise((resolve) => setTimeout(resolve, POST_ABORT_DELAY_MS))

		// Note: The caller holds sessionRetryInFlight. We do NOT manage it here.
		deps.sessionFirstTokenReceived.set(sessionID, false)
		let retryDispatched = false
		try {
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})
			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) {
				logError(`No messages found in session for auto-retry (${source})`, { sessionID })
			}

			// Look for the last user message that actually has content/parts
			const userMessages = msgs?.filter((m) => {
				const role = (m.info?.role ?? m.role ?? "") as string
				return role.toLowerCase() === "user"
			}) || []

			let lastUserMsg = undefined
			let lastUserPartsRaw = undefined

			// Search backwards for a user message with parts
			for (let i = userMessages.length - 1; i >= 0; i--) {
				const m = userMessages[i]
				const parts = m.parts ?? (m.info?.parts as any[] | undefined)
				if (parts && parts.length > 0) {
					lastUserMsg = m
					lastUserPartsRaw = parts
					break
				}
			}

			if (lastUserPartsRaw && lastUserPartsRaw.length > 0) {
				// Second stale check: re-verify after all async work (abort + delay +
				// message fetch).  Another handler may have advanced the state during
				// any of the awaits above.
				const postCheckState = sessionStates.get(sessionID)
				if (postCheckState && postCheckState.currentModel !== newModel) {
					logInfo(`Skipping stale autoRetryWithFallback after async work (${source})`, {
						sessionID,
						staleModel: newModel,
						currentModel: postCheckState.currentModel,
					})
					return
				}

				logInfo(`Auto-retrying with fallback model (${source})`, {
					sessionID,
					model: newModel,
				})

				// Cast raw parts to MessagePart (runtime parts may have any shape)
				const allParts: MessagePart[] = lastUserPartsRaw.filter(
					(p): p is MessagePart => typeof p.type === "string"
				)

				if (allParts.length > 0) {
					// Build the send function that calls promptAsync
					const sendFn = async (parts: MessagePart[]): Promise<void> => {
						await ctx.client.session.promptAsync({
							path: { id: sessionID },
							body: {
								...(resolvedAgent ? { agent: resolvedAgent } : {}),
								model: fallbackModelObj,
								parts,
							},
							query: { directory: ctx.directory },
						})
					}

					const replayResult = await replayWithDegradation(allParts, sendFn)

					if (replayResult.success) {
						sessionAwaitingFallbackResult.add(sessionID)
						scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
						retryDispatched = true

						logInfo(`Fallback replay succeeded (${source})`, {
							sessionID,
							tier: replayResult.tier,
							sentPartsCount: replayResult.sentParts?.length,
							droppedTypes: replayResult.droppedTypes,
						})

						// Show toast if parts were dropped (tier > 1)
						if (replayResult.droppedTypes && replayResult.droppedTypes.length > 0) {
							const droppedStr = replayResult.droppedTypes.join(", ")
							await ctx.client.tui
								.showToast({
									body: {
										title: "Message Replay",
										message: `Some message parts were dropped for compatibility: ${droppedStr}`,
										variant: "warning",
										duration: 5000,
									},
								})
								.catch(() => {})
						}
					} else {
						logError(`All replay tiers failed (${source})`, {
							sessionID,
							error: replayResult.error,
						})
					}
				}
			} else {
				logInfo(`No user message found for auto-retry (${source})`, { sessionID })
			}
		} catch (retryError) {
			logError(`Auto-retry failed (${source})`, {
				sessionID,
				error: String(retryError),
			})
			sessionAwaitingFallbackResult.delete(sessionID)
			clearSessionFallbackTimeout(sessionID)
		} finally {
			// Note: sessionRetryInFlight is managed by the caller, not here.
			if (!retryDispatched) {
				sessionAwaitingFallbackResult.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				const state = sessionStates.get(sessionID)
				if (state?.pendingFallbackModel) {
					state.pendingFallbackModel = undefined
				}
			}
		}
	}

	const resolveAgentForSessionFromContext = async (
		sessionID: string,
		eventAgent?: string
	): Promise<string | undefined> => {
		const resolved = resolveAgentForSession(sessionID, eventAgent)
		if (resolved) return resolved

		try {
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})
			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) return undefined

			for (let i = msgs.length - 1; i >= 0; i--) {
				const info = msgs[i]?.info
				const infoAgent = typeof info?.agent === "string" ? info.agent : undefined
				if (infoAgent && infoAgent.trim().length > 0) {
					return infoAgent.trim().toLowerCase()
				}
			}
		} catch {
			logError("Failed to resolve agent from messages", { sessionID })
		}

		try {
			const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } })
			const sessionData = (sessionInfo?.data ?? sessionInfo) as Record<string, unknown>
			const sdkAgent =
				typeof sessionData?.agent === "string" ? sessionData.agent : undefined
			if (sdkAgent && sdkAgent.trim().length > 0) {
				const normalized = sdkAgent.trim().toLowerCase()
				logInfo("Resolved agent from session.get", { sessionID, agent: normalized })
				return normalized
			}
		} catch {
			logError("Failed to resolve agent from session.get", { sessionID })
		}

		return undefined
	}

	const cleanupStaleSessions = () => {
		const now = Date.now()
		let cleanedCount = 0
		for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
			if (now - lastAccess > SESSION_TTL_MS) {
				sessionStates.delete(sessionID)
				sessionLastAccess.delete(sessionID)
				sessionRetryInFlight.delete(sessionID)
				sessionAwaitingFallbackResult.delete(sessionID)
				deps.sessionFirstTokenReceived.delete(sessionID)
				deps.sessionSelfAbortTimestamp.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				cleanedCount++
			}
		}
		if (cleanedCount > 0) {
			logInfo(`Cleaned up ${cleanedCount} stale session states`)
		}
	}

	return {
		abortSessionRequest,
		clearSessionFallbackTimeout,
		scheduleSessionFallbackTimeout,
		autoRetryWithFallback,
		resolveAgentForSessionFromContext,
		cleanupStaleSessions,
	}
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
