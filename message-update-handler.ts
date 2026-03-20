import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { PLUGIN_NAME } from "./constants"
import {
	extractStatusCode,
	extractErrorName,
	classifyErrorType,
	isRetryableError,
	extractAutoRetrySignal,
	containsErrorContent,
	extractErrorContentFromParts,
	detectErrorInTextParts,
} from "./error-classifier"
import { createFallbackState, prepareFallback } from "./fallback-state"
import { getFallbackModelsForSession } from "./config-reader"
import { logInfo, logError } from "./logger"

function logMessage(level: "info" | "error", message: string, context?: Record<string, unknown>): void {
	if (level === "error") {
		logError(message, context)
	} else {
		logInfo(message, context)
	}
}

export function hasVisibleAssistantResponse(
	extractAutoRetrySignalFn: typeof extractAutoRetrySignal
) {
	return async (
		ctx: HookDeps["ctx"],
		sessionID: string,
		_info: Record<string, unknown> | undefined
	): Promise<boolean> => {
		try {
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})

			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) return false

			const lastAssistant = [...msgs]
				.reverse()
				.find((m) => m.info?.role === "assistant")
			if (!lastAssistant) return false
			if (lastAssistant.info?.error) return false

			const parts =
				lastAssistant.parts ??
				(lastAssistant.info?.parts as
					| Array<{ type?: string; text?: string }>
					| undefined)

			const textFromParts = (parts ?? [])
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text!.trim())
				.filter((text) => text.length > 0)
				.join("\n")

			if (!textFromParts) return false
			if (extractAutoRetrySignalFn({ message: textFromParts })) return false

			return true
		} catch {
			return false
		}
	}
}

async function checkLastAssistantForErrorContent(
	ctx: HookDeps["ctx"],
	sessionID: string
): Promise<string | undefined> {
	try {
		const messagesResp = await ctx.client.session.messages({
			path: { id: sessionID },
			query: { directory: ctx.directory },
		})

		const msgs = messagesResp.data
		if (!msgs || msgs.length === 0) return undefined

		const lastAssistant = [...msgs]
			.reverse()
			.find((m) => m.info?.role === "assistant")
		if (!lastAssistant) return undefined

		const parts =
			lastAssistant.parts ??
			(lastAssistant.info?.parts as
				| Array<{ type?: string; text?: string }>
				| undefined)

		const result = extractErrorContentFromParts(parts)
		if (result.hasError) return result.errorMessage

		const textResult = detectErrorInTextParts(parts)
		if (textResult.hasError) return textResult.errorMessage

		return undefined
	} catch {
		return undefined
	}
}

export function createMessageUpdateHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
	} = deps
	const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)

	return async (props: Record<string, unknown> | undefined) => {
		const info = props?.info as Record<string, unknown> | undefined
		const sessionID = info?.sessionID as string | undefined
		const retrySignalResult = extractAutoRetrySignal(info)
		const retrySignal = retrySignalResult?.signal
		const timeoutEnabled = config.timeout_seconds > 0 || config.ttft_timeout_seconds > 0
		const parts = props?.parts as
			| Array<{ type?: string; text?: string }>
			| undefined
		const errorContentResult = containsErrorContent(parts)
		let error =
			info?.error ??
			(retrySignal && timeoutEnabled
				? { name: "ProviderRateLimitError", message: retrySignal }
				: undefined) ??
			(errorContentResult.hasError
				? {
						name: "MessageContentError",
						message:
							errorContentResult.errorMessage ||
							"Message contains error content",
					}
				: undefined)
		const role = info?.role as string | undefined
		const model =
			(info?.model as string | undefined) ??
			(typeof info?.providerID === "string" && typeof info?.modelID === "string"
				? `${info.providerID}/${info.modelID}`
				: undefined)

		if (sessionID && role === "assistant") {
			logInfo("message.updated received", {
				sessionID,
				model,
				hasInfoError: !!info?.error,
				errorType: info?.error ? classifyErrorType(info.error) : undefined,
			})
		}

		if (sessionID && role === "assistant" && !error) {
			const errorContent = await checkLastAssistantForErrorContent(ctx, sessionID)
			if (errorContent) {
				logInfo("Detected error content in message parts", {
					sessionID,
					errorContent: errorContent.slice(0, 200),
				})
				error = { name: "ContentError", message: errorContent }
			}
		}

		if (sessionID && role === "assistant" && !error) {
			if (!sessionAwaitingFallbackResult.has(sessionID)) {
				return
			}

			// TTFT: mark that first token has been received — prevents TTFT timeout from aborting
			deps.sessionFirstTokenReceived.set(sessionID, true)

			const hasVisible = await checkVisibleResponse(ctx, sessionID, info)
			if (!hasVisible) {
				logError(
					"Assistant update observed without visible final response; keeping fallback timeout",
					{ sessionID, model }
				)
				return
			}

			sessionAwaitingFallbackResult.delete(sessionID)
			helpers.clearSessionFallbackTimeout(sessionID)
			const state = sessionStates.get(sessionID)
			if (state?.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}
			logInfo("Assistant response observed; cleared fallback timeout", {
				sessionID,
				model,
			})
			return
		}

		if (sessionID && role === "assistant" && error) {
			// Ignore stale errors from models we already moved past
			const currentState = sessionStates.get(sessionID)
			if (currentState && model && model !== currentState.currentModel) {
				logInfo("Ignoring stale error from previous model", {
					sessionID,
					staleModel: model,
					currentModel: currentState.currentModel,
					errorName: extractErrorName(error),
				})
				return
			}
			
			sessionAwaitingFallbackResult.delete(sessionID)
			if (sessionRetryInFlight.has(sessionID) && !retrySignal) {
				logInfo("message.updated fallback skipped (retry in flight)", {
					sessionID,
				})
				return
			}

			if (
				retrySignal &&
				sessionRetryInFlight.has(sessionID) &&
				timeoutEnabled
			) {
				logError(
					"Overriding in-flight retry due to provider auto-retry signal",
					{ sessionID, model }
				)
				await helpers.abortSessionRequest(
					sessionID,
					"message.updated.retry-signal"
				)
				sessionRetryInFlight.delete(sessionID)
			}

			if (retrySignal && timeoutEnabled) {
				logInfo("Detected provider auto-retry signal", { sessionID, model })
			}

			if (!retrySignal) {
				helpers.clearSessionFallbackTimeout(sessionID)
			}

			logInfo("message.updated with assistant error", {
				sessionID,
				model,
				statusCode: extractStatusCode(error, config.retry_on_errors),
				errorName: extractErrorName(error),
				errorType: classifyErrorType(error),
			})

			let state = sessionStates.get(sessionID)
			const agent = info?.agent as string | undefined
			const resolvedAgent =
				await helpers.resolveAgentForSessionFromContext(sessionID, agent)
			const fallbackModels = getFallbackModelsForSession(
				sessionID,
				resolvedAgent,
				deps.agentConfigs,
				deps.globalFallbackModels
			)

			if (fallbackModels.length === 0) {
				return
			}

			// Prevent duplicate triggers for the same failure
			// We only skip if the error is from a model that is NOT the one we're currently 
			// waiting for a fallback result from. If it IS the pending model, it means
			// the fallback itself failed, and we should proceed to the next one.
			if (state && state.pendingFallbackModel && model !== state.pendingFallbackModel) {
				logInfo("Skipping duplicate fallback trigger (already in progress for different model)", {
					sessionID,
					pendingFallbackModel: state.pendingFallbackModel,
					errorModel: model
				})
				return
			}

			const isRetryable = isRetryableError(error, config.retry_on_errors)
			const inFallbackChain = state && state.currentModel !== state.originalModel
			
			if (!isRetryable && !inFallbackChain) {
				logError(
					"message.updated error not retryable and not in fallback chain, skipping",
					{
						sessionID,
						statusCode: extractStatusCode(error, config.retry_on_errors),
						errorName: extractErrorName(error),
						errorType: classifyErrorType(error),
					}
				)
				return
			}
			
			if (!isRetryable && inFallbackChain) {
				logInfo("message.updated non-retryable error but in fallback chain, continuing", {
					sessionID,
					currentModel: state?.currentModel,
					originalModel: state?.originalModel,
					errorName: extractErrorName(error),
				})
			}

			if (!state) {
				let initialModel = model
				if (!initialModel) {
					const agentConfig =
						resolvedAgent && deps.agentConfigs
							? (deps.agentConfigs[resolvedAgent] as
									| Record<string, unknown>
									| undefined)
							: undefined
					const agentModel = agentConfig?.model as string | undefined
					if (agentModel) {
						logError(
							"Derived model from agent config for message.updated",
							{
								sessionID,
								agent: resolvedAgent,
								model: agentModel,
							}
						)
						initialModel = agentModel
					}
				}

				if (!initialModel) {
					logError(
						"message.updated missing model info, cannot fallback",
						{
							sessionID,
							errorName: extractErrorName(error),
							errorType: classifyErrorType(error),
						}
					)
					return
				}

				state = createFallbackState(initialModel)
				sessionStates.set(sessionID, state)
				sessionLastAccess.set(sessionID, Date.now())
			} else {
				sessionLastAccess.set(sessionID, Date.now())
				
				// Handle auto-retry signals from providers
				if (state.pendingFallbackModel && retrySignal && timeoutEnabled) {
					logError(
						"Clearing pending fallback due to provider auto-retry signal",
						{
							sessionID,
							pendingFallbackModel: state.pendingFallbackModel,
						}
					)
					state.pendingFallbackModel = undefined
				}
			}

			const result = prepareFallback(
				sessionID,
				state,
				fallbackModels,
				config
			)

			if (result.success && result.newModel) {
				// Mark retry in flight IMMEDIATELY to prevent race conditions from other events
				deps.sessionRetryInFlight.add(sessionID)

				if (config.notify_on_fallback) {
					deps.ctx.client.tui
						.showToast({
							body: {
								title: "Model Fallback",
								message: `Switching to ${result.newModel?.split("/").pop() || result.newModel} for next request`,
								variant: "warning",
								duration: 5000,
							},
						})
						.catch(() => {})
				}

				try {
					await helpers.autoRetryWithFallback(
						sessionID,
						result.newModel,
						resolvedAgent,
						"message.updated"
					)
				} finally {
					deps.sessionRetryInFlight.delete(sessionID)
				}
			}


			if (result.success && result.newModel) {
				logInfo(`Calling autoRetryWithFallback from message.updated`, {
					sessionID,
					newModel: result.newModel,
				})
				try {
					await helpers.autoRetryWithFallback(
						sessionID,
						result.newModel,
						resolvedAgent,
						"message.updated"
					)
					logInfo(`autoRetryWithFallback returned successfully in message.updated`, { sessionID })
				} catch (e) {
					logError(`autoRetryWithFallback THREW ERROR in message.updated`, {
						sessionID,
						error: String(e),
						stack: e instanceof Error ? e.stack : undefined
					})
				}
			} else {
				logInfo(`Fallback not prepared in message.updated`, {
					sessionID,
					success: result.success,
					newModel: result.newModel
				})
			}
		}
	}
}
