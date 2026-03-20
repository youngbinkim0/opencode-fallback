import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { logInfo, logError } from "./logger"
import {
	extractStatusCode,
	extractErrorName,
	classifyErrorType,
	isRetryableError,
} from "./error-classifier"
import { createFallbackState, prepareFallback } from "./fallback-state"
import { getFallbackModelsForSession } from "./config-reader"

export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
		sessionFallbackTimeouts,
	} = deps

	const handleSessionCreated = (props: Record<string, unknown> | undefined) => {
		const sessionInfo = props?.info as { id?: string } | undefined
		const sessionID = sessionInfo?.id
		if (!sessionID) return

		logInfo("Session created, state will be created on-demand", { sessionID })
	}

	const handleSessionDeleted = (props: Record<string, unknown> | undefined) => {
		const sessionInfo = props?.info as { id?: string } | undefined
		const sessionID = sessionInfo?.id

		if (sessionID) {
			logInfo("Cleaning up session state", { sessionID })
			sessionStates.delete(sessionID)
			sessionLastAccess.delete(sessionID)
			sessionRetryInFlight.delete(sessionID)
			sessionAwaitingFallbackResult.delete(sessionID)
			helpers.clearSessionFallbackTimeout(sessionID)
		}
	}

	const handleSessionStop = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		if (!sessionID) return

		helpers.clearSessionFallbackTimeout(sessionID)

		if (
			sessionRetryInFlight.has(sessionID) ||
			sessionAwaitingFallbackResult.has(sessionID)
		) {
			await helpers.abortSessionRequest(sessionID, "session.stop")
		}

		sessionRetryInFlight.delete(sessionID)
		sessionAwaitingFallbackResult.delete(sessionID)

		const state = sessionStates.get(sessionID)
		if (state?.pendingFallbackModel) {
			state.pendingFallbackModel = undefined
		}

		logInfo("Cleared fallback retry state on session.stop", { sessionID })
	}

	const handleSessionIdle = (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		if (!sessionID) return

		if (sessionAwaitingFallbackResult.has(sessionID)) {
			logInfo("session.idle while awaiting fallback result; keeping timeout armed", {
				sessionID,
			})
			return
		}

		const hadTimeout = sessionFallbackTimeouts.has(sessionID)
		helpers.clearSessionFallbackTimeout(sessionID)
		sessionRetryInFlight.delete(sessionID)

		const state = sessionStates.get(sessionID)
		if (state?.pendingFallbackModel) {
			state.pendingFallbackModel = undefined
		}

		if (hadTimeout) {
			logInfo("Cleared fallback timeout after session completion", { sessionID })
		}
	}

	const handleSessionStatus = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		const status = props?.status as
			| { type?: string; attempt?: number; message?: string; next?: number }
			| undefined
		if (!sessionID || !status || status.type !== "retry") return

		const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
			sessionID,
			undefined
		)
		const fallbackModels = getFallbackModelsForSession(
			sessionID,
			resolvedAgent,
			deps.agentConfigs,
			deps.globalFallbackModels
		)

		logInfo("Provider retry detected", {
			sessionID,
			attempt: status.attempt,
			message: status.message,
			nextRetryMs: status.next,
			resolvedAgent,
			totalFallbackModels: fallbackModels.length,
		})

		if (fallbackModels.length === 0) {
			if (config.notify_on_fallback) {
				await deps.ctx.client.tui
					.showToast({
						body: {
							title: "Provider Retrying",
							variant: "info",
							duration: 3000,
							message: `${status.message || "retrying..."} (no fallback models configured)`,
						},
					})
					.catch(() => {})
			}
			return
		}

		// Check if provider retry is too far in the future - trigger immediate fallback
		const nextRetryMs = status.next
		if (typeof nextRetryMs === "number" && nextRetryMs > 0) {
			const now = Date.now()
			const timeoutMs = config.timeout_seconds * 1000
			// nextRetryMs is a timestamp, check if it's beyond our timeout
			if (nextRetryMs > now + timeoutMs) {
				logInfo("Provider retry is beyond timeout, triggering immediate fallback", {
					sessionID,
					nextRetryMs,
					now,
					timeoutMs,
					diffSeconds: Math.round((nextRetryMs - now) / 1000),
				})
				// Skip the normal flow and trigger fallback immediately
				await triggerImmediateFallback(sessionID, resolvedAgent, fallbackModels, status)
				return
			}
		}

		let state = sessionStates.get(sessionID)
		if (!state) {
			const agentConfig =
				resolvedAgent && deps.agentConfigs
					? (deps.agentConfigs[resolvedAgent] as Record<string, unknown> | undefined)
					: undefined
			const initialModel = (agentConfig?.model as string | undefined) ?? findFirstAgentModel()
			if (!initialModel) {
				logInfo("No model info for session.status fallback", { sessionID })
				return
			}
			logInfo("Creating on-demand state for session.status", {
				sessionID,
				model: initialModel,
				agent: resolvedAgent,
			})
			state = createFallbackState(initialModel)
			sessionStates.set(sessionID, state)
			sessionLastAccess.set(sessionID, Date.now())
		} else {
			sessionLastAccess.set(sessionID, Date.now())
		}

		sessionAwaitingFallbackResult.delete(sessionID)
		helpers.clearSessionFallbackTimeout(sessionID)

		const result = prepareFallback(sessionID, state, fallbackModels, config)

		if (result.success && result.newModel) {
			// Mark retry in flight IMMEDIATELY
			deps.sessionRetryInFlight.add(sessionID)

			if (config.notify_on_fallback) {
				const modelName = result.newModel?.split("/").pop() || result.newModel
				deps.ctx.client.tui
					.showToast({
						body: {
							title: "Retry Detected -- Switching Model",
							variant: "warning",
							duration: 5000,
							message: `${status.message || "Provider retrying"} -> ${modelName} (attempt ${state.attemptCount} of ${fallbackModels.length})`,
						},
					})
					.catch(() => {})
			}

			await helpers.autoRetryWithFallback(
				sessionID,
				result.newModel,
				resolvedAgent,
				"session.status"
			)
		} else if (!result.success) {
			logError("session.status fallback failed", {
				sessionID,
				error: result.error,
			})
			if (result.maxAttemptsReached && config.notify_on_fallback) {
				await deps.ctx.client.tui
					.showToast({
						body: {
							title: "All Fallbacks Exhausted",
							variant: "error",
							duration: 8000,
							message: `All ${fallbackModels.length} fallback models exhausted after ${state.attemptCount} attempts`,
						},
					})
					.catch(() => {})
			}
		}
	}

	const handleSessionError = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		const error = props?.error
		const agent = props?.agent as string | undefined
		const errorModel = props?.model as string | undefined

		if (!sessionID) {
			logInfo("session.error without sessionID, skipping")
			return
		}

		// Ignore stale errors from models we already moved past
		const currentState = sessionStates.get(sessionID)
		if (currentState && errorModel && errorModel !== currentState.currentModel) {
			logInfo("Ignoring stale session.error from previous model", {
				sessionID,
				staleModel: errorModel,
				currentModel: currentState.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

		// If we're awaiting a fallback result, this session.error is likely
		// a stale abort from the previous model (session.error doesn't carry
		// a model field, so we can't check which model caused it)
		if (sessionAwaitingFallbackResult.has(sessionID)) {
			logInfo("Ignoring session.error while awaiting fallback result (likely stale abort)", {
				sessionID,
				currentModel: currentState?.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

		const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
			sessionID,
			agent
		)

		if (sessionRetryInFlight.has(sessionID)) {
			logInfo("session.error skipped -- retry in flight", {
				sessionID,
				retryInFlight: true,
			})
			return
		}

		helpers.clearSessionFallbackTimeout(sessionID)

		logInfo("session.error received", {
			sessionID,
			agent,
			resolvedAgent,
			statusCode: extractStatusCode(error, config.retry_on_errors),
			errorName: extractErrorName(error),
			errorType: classifyErrorType(error),
		})

		const isRetryable = isRetryableError(error, config.retry_on_errors)
		
		let state = sessionStates.get(sessionID)
		const fallbackModels = getFallbackModelsForSession(
			sessionID,
			resolvedAgent,
			deps.agentConfigs,
			deps.globalFallbackModels
		)

		if (fallbackModels.length === 0) {
			logInfo("No fallback models configured", { sessionID, agent })
			return
		}

		// Check if we're already in a fallback chain
		const inFallbackChain = state && state.currentModel !== state.originalModel
		
		if (!isRetryable && !inFallbackChain) {
			logInfo("Error not retryable and not in fallback chain, skipping", {
				sessionID,
				retryable: false,
				inFallbackChain: false,
				statusCode: extractStatusCode(error, config.retry_on_errors),
				errorName: extractErrorName(error),
				errorType: classifyErrorType(error),
			})
			return
		}
		
		if (!isRetryable && inFallbackChain) {
			logInfo("Non-retryable error but in fallback chain, continuing to next fallback", {
				sessionID,
				retryable: false,
				inFallbackChain: true,
				currentModel: state?.currentModel,
				originalModel: state?.originalModel,
				errorName: extractErrorName(error),
			})
		}

		if (!state) {
			const currentModel = props?.model as string | undefined
			if (currentModel) {
				state = createFallbackState(currentModel)
				sessionStates.set(sessionID, state)
				sessionLastAccess.set(sessionID, Date.now())
			} else {
				const agentConfig =
					resolvedAgent && deps.agentConfigs
						? (deps.agentConfigs[resolvedAgent] as Record<string, unknown> | undefined)
						: undefined
				const agentModel = agentConfig?.model as string | undefined
				if (agentModel) {
					logInfo("Derived model from agent config", {
						sessionID,
						agent: resolvedAgent,
						model: agentModel,
					})
					state = createFallbackState(agentModel)
					sessionStates.set(sessionID, state)
					sessionLastAccess.set(sessionID, Date.now())
				} else {
					const firstModel = findFirstAgentModel()
					if (firstModel) {
						logInfo("Using first available agent model for state creation", {
							sessionID,
							model: firstModel,
						})
						state = createFallbackState(firstModel)
						sessionStates.set(sessionID, state)
						sessionLastAccess.set(sessionID, Date.now())
					} else {
						logInfo("No model info available, cannot fallback", { sessionID })
						return
					}
				}
			}
		} else {
			sessionLastAccess.set(sessionID, Date.now())
		}

		const result = prepareFallback(sessionID, state, fallbackModels, config)

		if (result.success && result.newModel) {
			// Mark retry in flight IMMEDIATELY
			deps.sessionRetryInFlight.add(sessionID)

			if (config.notify_on_fallback) {
				const modelName = result.newModel?.split("/").pop() || result.newModel
				const attemptInfo = `attempt ${state.attemptCount} of ${fallbackModels.length}`
				deps.ctx.client.tui
					.showToast({
						body: {
							title: "Model Fallback",
							message: `Switching to ${modelName} (${attemptInfo})`,
							variant: "warning",
							duration: 5000,
						},
					})
					.catch(() => {})
			}

			await helpers.autoRetryWithFallback(
				sessionID,
				result.newModel,
				resolvedAgent,
				"session.error"
			)
		}

		if (!result.success) {
			logError("Fallback preparation failed", {
				sessionID,
				error: result.error,
			})
		}
	}

	function findFirstAgentModel(): string | undefined {
		if (!deps.agentConfigs) return undefined
		for (const agentName of Object.keys(deps.agentConfigs)) {
			const agentConfig = deps.agentConfigs[agentName] as
				| Record<string, unknown>
				| undefined
			const model = agentConfig?.model as string | undefined
			if (model) return model
		}
		return undefined
	}

	async function triggerImmediateFallback(
		sessionID: string,
		resolvedAgent: string | undefined,
		fallbackModels: string[],
		status: { type?: string; attempt?: number; message?: string; next?: number }
	): Promise<void> {
		// Create state if needed
		let state = sessionStates.get(sessionID)
		if (!state) {
			const agentConfig =
				resolvedAgent && deps.agentConfigs
					? (deps.agentConfigs[resolvedAgent] as Record<string, unknown> | undefined)
					: undefined
			const initialModel = (agentConfig?.model as string | undefined) ?? findFirstAgentModel()
			if (!initialModel) {
				logError("Cannot trigger immediate fallback - no model info", { sessionID })
				return
			}
			state = createFallbackState(initialModel)
			sessionStates.set(sessionID, state)
			sessionLastAccess.set(sessionID, Date.now())
		} else {
			sessionLastAccess.set(sessionID, Date.now())
		}

		sessionAwaitingFallbackResult.delete(sessionID)
		helpers.clearSessionFallbackTimeout(sessionID)

		const result = prepareFallback(sessionID, state, fallbackModels, config)

		if (result.success && config.notify_on_fallback) {
			const modelName = result.newModel?.split("/").pop() || result.newModel
			await deps.ctx.client.tui
				.showToast({
					body: {
						title: "Provider Retry Too Slow - Switching Model",
						variant: "warning",
						duration: 5000,
						message: `${status.message || "Provider retrying"} -> ${modelName} (immediate fallback)`,
					},
				})
				.catch(() => {})
		}

		if (result.success && result.newModel) {
			await helpers.autoRetryWithFallback(
				sessionID,
				result.newModel,
				resolvedAgent,
				"session.status.immediate"
			)
		} else if (!result.success) {
			logError("Immediate fallback preparation failed", {
				sessionID,
				error: result.error,
			})
			if (result.maxAttemptsReached && config.notify_on_fallback) {
				await deps.ctx.client.tui
					.showToast({
						body: {
							title: "All Fallbacks Exhausted",
							variant: "error",
							duration: 8000,
							message: `All ${fallbackModels.length} fallback models exhausted`,
						},
					})
					.catch(() => {})
			}
		}
	}

	return async ({ event }: { event: { type: string; properties?: unknown } }) => {
		if (!config.enabled) return

		const props = event.properties as Record<string, unknown> | undefined

		if (event.type === "session.created") {
			handleSessionCreated(props)
			return
		}
		if (event.type === "session.deleted") {
			handleSessionDeleted(props)
			return
		}
		if (event.type === "session.stop") {
			await handleSessionStop(props)
			return
		}
		if (event.type === "session.idle") {
			handleSessionIdle(props)
			return
		}
		if (event.type === "session.error") {
			await handleSessionError(props)
			return
		}
		if (event.type === "session.status") {
			await handleSessionStatus(props)
			return
		}
	}
}
