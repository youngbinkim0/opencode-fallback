import type { HookDeps, ChatMessageInput, ChatMessageOutput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState, recoverToOriginal } from "./fallback-state"
import { getFallbackModelsForSession, resolveAgentForSession } from "./config-reader"
import { logInfo, logError } from "./logger"

export function createChatMessageHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
	} = deps

	return async (input: ChatMessageInput, output: ChatMessageOutput) => {
		if (!config.enabled) return

		const { sessionID } = input
		let state = sessionStates.get(sessionID)

		if (!state) {
			return
		}

		sessionLastAccess.set(sessionID, Date.now())

		const requestedModel = input.model
			? `${input.model.providerID}/${input.model.modelID}`
			: undefined

		// If the user explicitly requests the model they're already on (the
		// fallback), adopt it as the new primary.  Without this, the recovery
		// logic would later "recover" back to the old originalModel when its
		// cooldown expires — even though the user deliberately chose to stay
		// on the current model.  This prevents a spurious "Recovered to X"
		// notification after a manual model selection.
		//
		// IMPORTANT: This check must happen BEFORE the recovery check below.
		// Otherwise recovery fires first, resetting to originalModel, and the
		// adoption check never sees the mismatch.
		if (
			requestedModel &&
			requestedModel === state.currentModel &&
			state.currentModel !== state.originalModel
		) {
			logInfo("Adopting current model as new primary (user confirmed manual selection)", {
				sessionID,
				model: requestedModel,
				previousOriginal: state.originalModel,
			})
			state.originalModel = requestedModel
			state.failedModels.clear()
			state.fallbackIndex = -1
			state.attemptCount = 0
			return
		}

		// Auto-recovery: check if primary model's cooldown has expired
		if (state.currentModel !== state.originalModel) {
			if (
				!sessionRetryInFlight.has(sessionID) &&
				!sessionAwaitingFallbackResult.has(sessionID)
			) {
				const recovered = recoverToOriginal(state, config.cooldown_seconds)
				if (recovered) {
					logInfo("Recovered to primary model", {
						sessionID,
						model: state.originalModel,
					})
					if (config.notify_on_fallback) {
						const modelName = state.originalModel.split("/").pop() || state.originalModel
						ctx.client.tui
							.showToast({
								body: {
									title: "Model Recovered",
									message: `Recovered to ${modelName}`,
									variant: "info",
									duration: 3000,
								},
							})
							.catch(() => {})
					}
				}
			}
		}

		if (requestedModel && requestedModel !== state.currentModel) {
			if (
				state.pendingFallbackModel &&
				state.pendingFallbackModel === requestedModel
			) {
				state.pendingFallbackModel = undefined
				return
			}

			// Check if this "mismatch" is just a stale retry from the race
			// between message.updated / session.error / session.status.
			// If the requestedModel is in the fallback chain and we're actively
			// retrying, this is NOT a manual change — it's a stale handler
			// sending its model while another handler already advanced the state.
			if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
				const resolvedAgent = resolveAgentForSession(sessionID, input.agent)
				const fallbackModels = getFallbackModelsForSession(
					sessionID,
					resolvedAgent,
					deps.agentConfigs,
					deps.globalFallbackModels
				)
				if (fallbackModels.includes(requestedModel)) {
					logInfo("Ignoring stale fallback model mismatch during active retry", {
						sessionID,
						requestedModel,
						currentModel: state.currentModel,
					})
					// Do NOT update state.currentModel here — let commitFallback
					// handle the state transition atomically.  Setting currentModel
					// during an active retry confuses commitFallback's idempotency
					// check and can cause it to abort a live replay.
					return
				}
			}

			logError("Detected manual model change, resetting fallback state", {
				sessionID,
				from: state.currentModel,
				to: requestedModel,
			})

			helpers.clearSessionFallbackTimeout(sessionID)
			sessionAwaitingFallbackResult.delete(sessionID)
			// Reset first-token tracking so the new model gets a fresh TTFT window.
			// Without this, the new model inherits firstTokenReceived=true from the
			// old model and TTFT is never scheduled.
			deps.sessionFirstTokenReceived.delete(sessionID)

			if (sessionRetryInFlight.has(sessionID)) {
				await helpers.abortSessionRequest(sessionID, "manual-model-change")
				sessionRetryInFlight.delete(sessionID)
			}

			state = createFallbackState(requestedModel)
			sessionStates.set(sessionID, state)
			return
		}

		if (state.currentModel === state.originalModel) return

		const activeModel = state.currentModel

		logInfo("Applying fallback model override", {
			sessionID,
			from: input.model,
			to: activeModel,
		})

		if (output.message && activeModel) {
			const parts = activeModel.split("/")
			if (parts.length >= 2) {
				output.message.model = {
					providerID: parts[0],
					modelID: parts.slice(1).join("/"),
				}
			}
		}
	}
}
