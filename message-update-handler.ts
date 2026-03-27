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
import {
	createFallbackState,
	prepareFallback,
	planFallback,
	snapshotFallbackState,
	restoreFallbackState,
} from "./fallback-state"
import { getFallbackModelsForSession } from "./config-reader"
import { logInfo, logError } from "./logger"

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
					| Array<{ type?: string; text?: string; name?: string }>
					| undefined)

			const hasToolCall = (parts ?? []).some((p) => p.type === "tool_call")
			
			const textFromParts = (parts ?? [])
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text!.trim())
				.filter((text) => text.length > 0)
				.join("\n")

			// If the model made a tool call, it's an active valid response regardless of text
			if (hasToolCall) return true

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
		const timeoutEnabled = config.timeout_seconds > 0
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
			// Track last message activity — used by subagent-sync to detect
			// that the child session is still alive and reset its timeout.
			deps.sessionLastMessageTime.set(sessionID, Date.now())

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
				// ── PRIMARY MODEL TTFT TIMEOUT ──
				// Schedule a TTFT timeout when we see the first message.updated for
				// a session that hasn't received a first token yet and doesn't
				// already have a timeout running.  This covers two scenarios:
				//   (a) Brand new session (no state yet) — create state and schedule
				//   (b) Manual model change — chat-message-handler created fresh
				//       state but didn't schedule a timeout.
				//
				// The key invariant: if timeout is enabled, first token not received,
				// and no timeout is running, we must schedule one.
				const needsTimeout =
					model &&
					config.timeout_seconds > 0 &&
					!deps.sessionFirstTokenReceived.get(sessionID) &&
					!deps.sessionFallbackTimeouts.has(sessionID)

				if (needsTimeout) {
					// Create state if this is a brand new session
					if (!sessionStates.has(sessionID)) {
						const state = createFallbackState(model)
						sessionStates.set(sessionID, state)
						sessionLastAccess.set(sessionID, Date.now())
					}

					// Resolve agent asynchronously for timeout handler
					const agent = info?.agent as string | undefined
					helpers.resolveAgentForSessionFromContext(sessionID, agent)
						.then((resolvedAgent) => {
							const fallbackModels = getFallbackModelsForSession(
								sessionID,
								resolvedAgent,
								deps.agentConfigs,
								deps.globalFallbackModels
							)
							if (fallbackModels.length > 0) {
								helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
								logInfo("Scheduled primary model TTFT timeout", {
									sessionID,
									model,
									timeoutSeconds: config.timeout_seconds,
								})
							}
						})
						.catch(() => {})
				} else if (sessionStates.has(sessionID)) {
					// Subsequent successful message.updated — model is active.
					// Mark first token received and reschedule the timeout.
					// The timeout's purpose is to detect models that go completely
					// silent (hung/dead). Any non-error message.updated proves the
					// model is alive, so we push the timeout forward. Only when
					// the model produces no updates for the full timeout_seconds
					// interval does the timeout fire.
					deps.sessionFirstTokenReceived.set(sessionID, true)
					// Reschedule the timeout — resets the clock on every activity.
					// If a timeout was scheduled but model is streaming, this
					// prevents the false-abort that occurred when the model was
					// actively producing tokens but firstTokenReceived was never set.
					if (deps.sessionFallbackTimeouts.has(sessionID)) {
						const agent = info?.agent as string | undefined
						helpers.resolveAgentForSessionFromContext(sessionID, agent)
							.then((resolvedAgent) => {
								helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
							})
							.catch(() => {})
					}
				}
				return
			}

			// Check whether actual text content has arrived.  OpenCode sends an
			// initial message.updated when it *creates* the assistant message
			// slot — before any tokens arrive.  We must NOT mark TTFT as
			// received for that empty frame; otherwise the timeout handler
			// skips the abort and the session gets stuck forever.
			const hasVisible = await checkVisibleResponse(ctx, sessionID, info)
			if (!hasVisible) {
				// Also check the event's own parts for any text content or tool calls.
				// If the event parts have text/tools, the model is streaming even
				// though the full-message fetch didn't find a complete response.
				const eventHasActivity = parts?.some(
					(p) => 
						(p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) ||
						p.type === "tool_call"
				)
				if (eventHasActivity) {
					deps.sessionFirstTokenReceived.set(sessionID, true)
				}
				logError(
					"Assistant update observed without visible final response; keeping fallback timeout",
					{ sessionID, model, firstTokenReceived: deps.sessionFirstTokenReceived.get(sessionID) ?? false }
				)
				return
			}

			// Full visible response confirmed — model produced real content
			deps.sessionFirstTokenReceived.set(sessionID, true)

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
			// ── COMPACTION IN-FLIGHT GUARD ──
			// Compaction via session.command produces no message.updated events.
			// Any error arriving while compaction is running is from the
			// pre-compaction model (stale) — suppress it entirely.
			if (deps.sessionCompactionInFlight.has(sessionID)) {
				logInfo("Ignoring message.updated error during compaction in-flight", {
					sessionID,
					model,
					errorName: extractErrorName(error),
				})
				return
			}

			// Ignore stale errors from models we already moved past
			const currentState = sessionStates.get(sessionID)
			if (currentState && model && model !== currentState.currentModel) {
				// If the error model is already in failedModels, this is a stale
				// echo from a model that already failed and was replaced.  Never
				// resync back to a model we already moved away from — that creates
				// an infinite loop: stale error → resync → plan fallback → replay
				// → stale error from the same model → resync again.
				const isAlreadyFailed = currentState.failedModels.has(model)

				const retryableStaleError = isRetryableError(
					error,
					config.retry_on_errors,
					config.retryable_error_patterns
				)
				const canResyncToErrorModel =
					retryableStaleError &&
					!isAlreadyFailed &&
					!currentState.pendingFallbackModel &&
					!sessionAwaitingFallbackResult.has(sessionID)

				if (canResyncToErrorModel) {
					logInfo("Resyncing state to error model before fallback planning", {
						sessionID,
						previousModel: currentState.currentModel,
						errorModel: model,
						errorName: extractErrorName(error),
					})
					currentState.currentModel = model
					sessionLastAccess.set(sessionID, Date.now())
				} else {
					logInfo("Ignoring stale error from previous model", {
						sessionID,
						staleModel: model,
						currentModel: currentState.currentModel,
						errorName: extractErrorName(error),
						isAlreadyFailed,
					})
					return
				}
			}

			// Safety net: if this is a MessageAbortedError and we recently
			// called session.abort() ourselves (within 2s window), this is a
			// self-inflicted abort from the fallback transition.  Ignore it —
			// the timeout handler (or whichever handler initiated the abort) is
			// already dispatching the fallback.
			//
			// We intentionally do NOT require sessionAwaitingFallbackResult to
			// be set: there is a micro-window between when the abort API call
			// returns and when the dispatching handler gets to set the awaiting
			// flag.  The MessageAbortedError event can arrive in that gap.
			const SELF_ABORT_WINDOW_MS = 2000
			const errorName = extractErrorName(error)
			const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID)
			if (
				errorName === "MessageAbortedError" &&
				selfAbortTs &&
				Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS
			) {
				logInfo("Ignoring self-inflicted MessageAbortedError (abort initiated by plugin)", {
					sessionID,
					model,
					msSinceAbort: Date.now() - selfAbortTs,
					awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
					retryInFlight: sessionRetryInFlight.has(sessionID),
				})
				return
			}
			
			sessionAwaitingFallbackResult.delete(sessionID)

			// ── EARLY LOCK ACQUISITION ──
			// Acquire the retry lock BEFORE any async work to prevent
			// session.error from interleaving via microtask scheduling.
			// Both message.updated and session.error fire for the same
			// original error; only one should advance the fallback state.
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

			// Acquire the lock now — before any async calls that could yield
			// and allow session.error to interleave.
			deps.sessionRetryInFlight.add(sessionID)

			try {
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
				if (state && state.pendingFallbackModel && model !== state.pendingFallbackModel) {
					logInfo("Skipping duplicate fallback trigger (already in progress for different model)", {
						sessionID,
						pendingFallbackModel: state.pendingFallbackModel,
						errorModel: model
					})
					return
				}

				const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns)
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

				const plan = planFallback(
					sessionID,
					state,
					fallbackModels,
					config,
				)

				if (plan.success) {
					if (config.notify_on_fallback) {
						deps.ctx.client.tui
							.showToast({
								body: {
									title: "Model Fallback",
									message: `Switching to ${plan.newModel?.split("/").pop() || plan.newModel} for next request`,
									variant: "warning",
									duration: 5000,
								},
							})
							.catch(() => {})
					}

					await helpers.autoRetryWithFallback(
						sessionID,
						plan.newModel,
						resolvedAgent,
						"message.updated",
						plan
					)
				}
			} finally {
				deps.sessionRetryInFlight.delete(sessionID)
			}
		}
	}
}
