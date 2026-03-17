import type { HookDeps, ChatMessageInput, ChatMessageOutput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { PLUGIN_NAME } from "./constants"
import { createFallbackState } from "./fallback-state"
import { logInfo, logError } from "./logger"

export function createChatMessageHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
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
