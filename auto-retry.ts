import type { HookDeps } from "./types"
import { logInfo, logError } from "./logger"
import { getFallbackModelsForSession, resolveAgentForSession } from "./config-reader"
import { prepareFallback } from "./fallback-state"

const SESSION_TTL_MS = 30 * 60 * 1000

declare function setTimeout(
	callback: () => void | Promise<void>,
	delay?: number
): ReturnType<typeof globalThis.setTimeout>
declare function clearTimeout(timeout: ReturnType<typeof globalThis.setTimeout>): void

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

			const state = sessionStates.get(sessionID)
			if (!state) return

			if (sessionRetryInFlight.has(sessionID)) {
				logInfo("Overriding in-flight retry due to session timeout", { sessionID })
			}

			await abortSessionRequest(sessionID, "session.timeout")
			sessionRetryInFlight.delete(sessionID)

			if (state.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}

			const fallbackModels = getFallbackModelsForSession(
				sessionID,
				resolvedAgent,
				deps.agentConfigs
			)
			if (fallbackModels.length === 0) return

			logInfo("Session fallback timeout reached", {
				sessionID,
				timeoutSeconds: config.timeout_seconds,
				currentModel: state.currentModel,
			})

			const result = prepareFallback(sessionID, state, fallbackModels, config)
			if (result.success && result.newModel) {
				await autoRetryWithFallback(
					sessionID,
					result.newModel,
					resolvedAgent,
					"session.timeout"
				)
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
		if (sessionRetryInFlight.has(sessionID)) {
			logInfo(`Retry already in flight, skipping (${source})`, { sessionID })
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

		sessionRetryInFlight.add(sessionID)
		let retryDispatched = false
		try {
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})
			const msgs = messagesResp.data
			const lastUserMsg = msgs?.filter((m) => m.info?.role === "user").pop()
			const lastUserPartsRaw =
				lastUserMsg?.parts ??
				(lastUserMsg?.info?.parts as Array<{ type?: string; text?: string }> | undefined)

			if (lastUserPartsRaw && lastUserPartsRaw.length > 0) {
				logInfo(`Auto-retrying with fallback model (${source})`, {
					sessionID,
					model: newModel,
				})

				const retryParts = lastUserPartsRaw
					.filter(
						(p) =>
							p.type === "text" && typeof p.text === "string" && p.text.length > 0
					)
					.map((p) => ({ type: "text" as const, text: p.text! }))

				if (retryParts.length > 0) {
					sessionAwaitingFallbackResult.add(sessionID)
					scheduleSessionFallbackTimeout(sessionID, resolvedAgent)

					logInfo(`Sending fallback prompt (${source})`, {
						sessionID,
						agent: resolvedAgent,
						model: fallbackModelObj,
						partsCount: retryParts.length,
						firstPart: retryParts[0]?.text?.slice(0, 80),
					})
					await ctx.client.session.promptAsync({
						path: { id: sessionID },
						body: {
							...(resolvedAgent ? { agent: resolvedAgent } : {}),
							model: fallbackModelObj,
							parts: retryParts,
						},
						query: { directory: ctx.directory },
					})
					retryDispatched = true
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
			sessionRetryInFlight.delete(sessionID)
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
