import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { logInfo, logError } from "./logger"
import {
	extractStatusCode,
	extractErrorName,
	classifyErrorType,
	isRetryableError,
} from "./error-classifier"
import {
	createFallbackState,
	prepareFallback,
	planFallback,
	snapshotFallbackState,
	restoreFallbackState,
} from "./fallback-state"
import { getFallbackModelsForSession, resolveAgentForSession } from "./config-reader"

export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
		sessionFallbackTimeouts,
	} = deps

	const handleActivity = async (sessionID: string) => {
		if (sessionAwaitingFallbackResult.has(sessionID)) {
			const resolvedAgent = resolveAgentForSession(sessionID, undefined)
			helpers.scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
			logInfo("Resetting fallback timeout due to activity", { sessionID })
			return
		}

		if (sessionAwaitingFallbackResult.size === 0) {
			return
		}

		const cachedParentID = deps.sessionParentID.get(sessionID)
		const parentID =
			cachedParentID !== undefined
				? cachedParentID
				: await helpers.getParentSessionID(sessionID)

		if (parentID && sessionAwaitingFallbackResult.has(parentID)) {
			const resolvedAgent = resolveAgentForSession(parentID, undefined)
			helpers.scheduleSessionFallbackTimeout(parentID, resolvedAgent)
			logInfo("Resetting parent fallback timeout due to child activity", {
				sessionID,
				parentID,
			})
		}
	}

	const handleSessionCreated = (props: Record<string, unknown> | undefined) => {
		const sessionInfo = props?.info as { id?: string } | undefined
		const sessionID = sessionInfo?.id
		if (!sessionID) return

		const parentID = (sessionInfo as Record<string, unknown> | undefined)?.parentID
		if (typeof parentID === "string" && parentID.length > 0) {
			deps.sessionParentID.set(sessionID, parentID)
		}

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
			deps.sessionFirstTokenReceived.delete(sessionID)
			deps.sessionSelfAbortTimestamp.delete(sessionID)
			deps.sessionParentID.delete(sessionID)
			deps.sessionIdleResolvers.delete(sessionID)
			deps.sessionLastMessageTime.delete(sessionID)
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
		deps.sessionSelfAbortTimestamp.delete(sessionID)

		const state = sessionStates.get(sessionID)
		if (state?.pendingFallbackModel) {
			state.pendingFallbackModel = undefined
		}

		logInfo("Cleared fallback retry state on session.stop", { sessionID })
	}

	const handleSessionIdle = async (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		if (!sessionID) return

		// Resolve any idle waiters FIRST (e.g. subagent-sync waiting for
		// a child session's fallback to complete). This must happen before
		// the sessionAwaitingFallbackResult early-return below, because
		// the waiter needs to know the child went idle regardless.
		const idleResolvers = deps.sessionIdleResolvers.get(sessionID)
		if (idleResolvers && idleResolvers.length > 0) {
			logInfo("session.idle resolving waiters", {
				sessionID,
				waiterCount: idleResolvers.length,
			})
			for (const resolve of idleResolvers) resolve()
			deps.sessionIdleResolvers.delete(sessionID)
		}

		if (sessionAwaitingFallbackResult.has(sessionID)) {
			// ── SILENT MODEL FAILURE DETECTION ──
			// If we dispatched a fallback model (sessionAwaitingFallbackResult is
			// set) but no first token was ever received, the model silently failed
			// (e.g. model_not_found, quota exceeded, empty response). Treat this
			// idle as a real failure and advance the fallback chain immediately
			// rather than waiting for the full TTFT timeout.
			const firstTokenReceived = deps.sessionFirstTokenReceived.get(sessionID)
			if (!firstTokenReceived) {
				const state = sessionStates.get(sessionID)
				if (state) {
				logInfo("session.idle detected silent model failure (no first token received)", {
					sessionID,
					currentModel: state.currentModel,
					attemptCount: state.attemptCount,
				})

				// Acquire retry lock BEFORE clearing the timeout.  The TTFT
				// timeout callback may already be queued in the event loop
				// (clearTimeout only prevents future scheduling, not already-
				// queued macrotasks).  By holding the lock first, any racing
				// timeout callback will see sessionRetryInFlight and bail out
				// at its own lock check, preventing dual planFallback calls.
				if (sessionRetryInFlight.has(sessionID)) {
					logInfo("session.idle silent failure — retry already in flight, skipping", {
						sessionID,
					})
					return
				}
				sessionRetryInFlight.add(sessionID)

				// Now safe to clear awaiting state and timeout
				sessionAwaitingFallbackResult.delete(sessionID)
				helpers.clearSessionFallbackTimeout(sessionID)

					try {
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
						if (fallbackModels.length === 0) {
							logInfo("session.idle silent failure — no fallback models configured", {
								sessionID,
							})
							return
						}

						const plan = planFallback(sessionID, state, fallbackModels, config)
						if (plan.success) {
							await helpers.autoRetryWithFallback(
								sessionID,
								plan.newModel,
								resolvedAgent,
								"session.idle.silent-failure",
								plan
							)
						} else {
							logInfo("session.idle silent failure — no more fallback models available", {
								sessionID,
								error: plan.error,
							})
						}
					} finally {
						sessionRetryInFlight.delete(sessionID)
					}
					return
				}
			}

			// First token was received and session went idle — the fallback
			// model completed its work (possibly with only tool calls, no text).
			// Clear the awaiting state so the session isn't stuck.
			logInfo("session.idle with first token received — fallback model completed", {
				sessionID,
			})
			sessionAwaitingFallbackResult.delete(sessionID)
			helpers.clearSessionFallbackTimeout(sessionID)
			sessionRetryInFlight.delete(sessionID)
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

		// ── EARLY LOCK ACQUISITION ──
		if (sessionRetryInFlight.has(sessionID)) {
			logInfo("session.status skipped -- retry lock already held", { sessionID })
			return
		}
		sessionRetryInFlight.add(sessionID)

		try {
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
				if (nextRetryMs > now + timeoutMs) {
					logInfo("Provider retry is beyond timeout, triggering immediate fallback", {
						sessionID,
						nextRetryMs,
						now,
						timeoutMs,
						diffSeconds: Math.round((nextRetryMs - now) / 1000),
					})
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

			const plan = planFallback(sessionID, state, fallbackModels, config)

			if (plan.success) {
				if (config.notify_on_fallback) {
					const modelName = plan.newModel?.split("/").pop() || plan.newModel
					deps.ctx.client.tui
						.showToast({
							body: {
								title: "Retry Detected -- Switching Model",
								variant: "warning",
								duration: 5000,
								message: `${status.message || "Provider retrying"} -> ${modelName} (attempt ${state.attemptCount + 1} of ${fallbackModels.length})`,
							},
						})
						.catch(() => {})
				}

				await helpers.autoRetryWithFallback(
					sessionID,
					plan.newModel,
					resolvedAgent,
					"session.status",
					plan
				)
			} else if (!plan.success) {
				logError("session.status fallback failed", {
					sessionID,
					error: plan.error,
				})
				if (plan.maxAttemptsReached && config.notify_on_fallback) {
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
		} finally {
			sessionRetryInFlight.delete(sessionID)
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

		// ── SELF-ABORT GUARD ──
		// If this is a MessageAbortedError from a plugin-initiated abort
		// (TTFT timeout, pre-fallback abort, etc.), suppress it.  The handler
		// that initiated the abort is already dispatching the fallback.
		// We check this FIRST, before any stale-model or pending guards,
		// because those guards may not yet reflect the in-progress transition.
		const SELF_ABORT_WINDOW_MS = 2000
		const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID)
		const errorName = extractErrorName(error)
		if (
			errorName === "MessageAbortedError" &&
			selfAbortTs &&
			Date.now() - selfAbortTs < SELF_ABORT_WINDOW_MS
		) {
			logInfo("Ignoring self-inflicted MessageAbortedError in session.error", {
				sessionID,
				msSinceAbort: Date.now() - selfAbortTs,
				awaitingFallback: sessionAwaitingFallbackResult.has(sessionID),
				retryInFlight: sessionRetryInFlight.has(sessionID),
			})
			return
		}

		// Ignore stale errors from models we already moved past
		const currentState = sessionStates.get(sessionID)
		if (currentState?.pendingFallbackModel) {
			logInfo("Ignoring session.error while fallback replay is pending", {
				sessionID,
				pendingFallbackModel: currentState.pendingFallbackModel,
				currentModel: currentState.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

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
		// a model field, so we can't reliably tell which model caused it).
		//
		// If the fallback model itself fails silently (no message.updated error,
		// no first token), the session.idle handler will detect it via the
		// "silent model failure" path and advance the chain.
		if (sessionAwaitingFallbackResult.has(sessionID)) {
			logInfo("Ignoring session.error while awaiting fallback result (likely stale abort)", {
				sessionID,
				currentModel: currentState?.currentModel,
				errorName: extractErrorName(error),
			})
			return
		}

		// ── EARLY LOCK ACQUISITION ──
		// Acquire the lock BEFORE any async work (resolveAgentForSessionFromContext).
		// Both message.updated and session.error fire simultaneously for the same
		// error.  The first handler to reach this point wins; the other bails out.
		if (sessionRetryInFlight.has(sessionID)) {
			logInfo("session.error skipped -- retry in flight (early lock)", {
				sessionID,
				retryInFlight: true,
			})
			return
		}
		sessionRetryInFlight.add(sessionID)

		try {
			const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
				sessionID,
				agent
			)

			helpers.clearSessionFallbackTimeout(sessionID)

			// Re-check pendingFallbackModel after the await — message.updated may
			// have created state and called prepareFallback while we were resolving
			// the agent.  This is the primary guard against the dual-handler race.
			const stateAfterAwait = sessionStates.get(sessionID)
			if (stateAfterAwait?.pendingFallbackModel) {
				logInfo("Ignoring session.error — fallback replay became pending during agent resolution", {
					sessionID,
					pendingFallbackModel: stateAfterAwait.pendingFallbackModel,
					currentModel: stateAfterAwait.currentModel,
					errorName: extractErrorName(error),
				})
				return
			}

			logInfo("session.error received", {
				sessionID,
				agent,
				resolvedAgent,
				statusCode: extractStatusCode(error, config.retry_on_errors),
				errorName: extractErrorName(error),
				errorType: classifyErrorType(error),
			})

			const isRetryable = isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns)
			
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
				} else if (!errorModel && sessionRetryInFlight.has(sessionID)) {
					// No state, no model on the error, and message.updated holds the
					// retry lock — this is a stale session.error for the same failure
					// that message.updated is already handling.  Defer entirely.
					logInfo("Deferring to message.updated handler (no state, no errorModel, retry in flight)", {
						sessionID,
						errorName: extractErrorName(error),
					})
					return
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

			const plan = planFallback(sessionID, state, fallbackModels, config)

			if (plan.success) {
				if (config.notify_on_fallback) {
					const modelName = plan.newModel?.split("/").pop() || plan.newModel
					const attemptInfo = `attempt ${state.attemptCount + 1} of ${fallbackModels.length}`
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
					plan.newModel,
					resolvedAgent,
					"session.error",
					plan
				)
			} else {
				logError("Fallback preparation failed", {
					sessionID,
					error: plan.error,
				})
			}
		} finally {
			sessionRetryInFlight.delete(sessionID)
		}
	}

	const handleSessionCompacted = (props: Record<string, unknown> | undefined) => {
		const sessionID = props?.sessionID as string | undefined
		if (!sessionID) return

		const hadAwaiting = sessionAwaitingFallbackResult.has(sessionID)

		// Clear all fallback tracking state — compaction completed successfully
		sessionAwaitingFallbackResult.delete(sessionID)
		sessionRetryInFlight.delete(sessionID)
		deps.sessionFirstTokenReceived.delete(sessionID)
		helpers.clearSessionFallbackTimeout(sessionID)

		if (hadAwaiting) {
			logInfo("Compaction completed, clearing fallback state", { sessionID })
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

	// Called from handleSessionStatus which already holds the sessionRetryInFlight lock.
	// Does NOT acquire/release the lock itself.
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

		const plan = planFallback(sessionID, state, fallbackModels, config)

		if (plan.success) {
			if (config.notify_on_fallback) {
				const modelName = plan.newModel?.split("/").pop() || plan.newModel
				deps.ctx.client.tui
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

			await helpers.autoRetryWithFallback(
				sessionID,
				plan.newModel,
				resolvedAgent,
				"session.status.immediate",
				plan
			)
		} else if (!plan.success) {
			logError("Immediate fallback preparation failed", {
				sessionID,
				error: plan.error,
			})
			if (plan.maxAttemptsReached && config.notify_on_fallback) {
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

	return {
		handleEvent: async ({ event }: { event: { type: string; properties?: unknown } }) => {
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
				await handleSessionIdle(props)
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
			if (event.type === "session.compacted") {
				handleSessionCompacted(props)
				return
			}
		},
		handleActivity,
	}
}
