import type { HookDeps, ChatMessageInput, ChatMessageOutput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { PLUGIN_NAME } from "./constants"
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

		if (!state) return

		sessionLastAccess.set(sessionID, Date.now())

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

		const requestedModel = input.model
			? `${input.model.providerID}/${input.model.modelID}`
			: undefined

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
					// Update state to match what's actually being sent
					state.currentModel = requestedModel
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
