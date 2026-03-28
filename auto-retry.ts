import type { HookDeps, MessagePart, FallbackPlan } from "./types"
import { logInfo, logError } from "./logger"
import { getFallbackModelsForSession, resolveAgentForSession } from "./config-reader"
import { prepareFallback, planFallback, commitFallback, createFallbackState } from "./fallback-state"
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

function summarizeParts(parts: MessagePart[] | undefined): {
	count: number
	types: string[]
	textChars: number
	hasToolCall: boolean
} {
	if (!parts || parts.length === 0) {
		return { count: 0, types: [], textChars: 0, hasToolCall: false }
	}

	const typeSet = new Set<string>()
	let textChars = 0
	let hasToolCall = false

	for (const part of parts) {
		typeSet.add(part.type)
		const textValue = (part as Record<string, unknown>).text
		if (part.type === "text" && typeof textValue === "string") {
			textChars += textValue.length
		}
		if (part.type === "tool_call") {
			hasToolCall = true
		}
	}

	return {
		count: parts.length,
		types: Array.from(typeSet),
		textChars,
		hasToolCall,
	}
}

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

	/** Look up the parentID for a session, with caching.
	 *  Returns the parentID string if this is a child session, or null. */
	const getParentSessionID = async (sessionID: string): Promise<string | null> => {
		const cached = deps.sessionParentID.get(sessionID)
		if (cached !== undefined) return cached

		try {
			const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } })
			const sessionData = (sessionInfo?.data ?? sessionInfo) as Record<string, unknown>
			const parentID = typeof sessionData?.parentID === "string" && sessionData.parentID.length > 0
				? sessionData.parentID
				: null
			deps.sessionParentID.set(sessionID, parentID)
			if (parentID) {
				logInfo("Detected child session", { sessionID, parentID })
			}
			return parentID
		} catch {
			logError("Failed to look up parentID", { sessionID })
			return null
		}
	}

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

			// If another handler (e.g. session.idle silent-failure or
			// session.status) already holds the retry lock, it is already
			// advancing the fallback chain.  Don't interfere.
			if (sessionRetryInFlight.has(sessionID)) {
				logInfo("Timeout fired but retry already in flight, deferring", { sessionID })
				return
			}

			// For TTFT timeouts we MUST abort even for child sessions — the
			// hung model is still consuming the session and we cannot send a
			// replay until it is stopped.  The downstream autoRetryWithFallback
			// will handle the child-session concern (skipping its own abort
			// since we already did it here).
			//
			// Clear compaction-in-flight: the compaction timed out, so the
			// next attempt needs a clean slate (the new autoRetryWithFallback
			// call will re-set the flag if it dispatches compaction again).
			deps.sessionCompactionInFlight.delete(sessionID)
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
				const plan = planFallback(sessionID, state, fallbackModels, config)
				if (plan.success) {
					await autoRetryWithFallback(
						sessionID,
						plan.newModel,
						resolvedAgent,
						"session.timeout",
						plan
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
		source: string,
		plan?: FallbackPlan
	): Promise<boolean> => {
		// Track whether we skipped because another handler owns the dispatch.
		// In that case, the finally block must NOT clear sessionAwaitingFallbackResult.
		let deferredToOtherHandler = false

		// Guard: if the state has already been advanced past this model by
		// a concurrent handler (race between message.updated / session.error /
		// session.status), skip this retry — the other handler owns it now.
		// When using plan-based flow, state hasn't been committed yet, so
		// check against the failed model (which should still be current).
		const preCheckState = sessionStates.get(sessionID)
		if (plan) {
			if (preCheckState && preCheckState.currentModel !== plan.failedModel) {
				logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, expected failed model ${plan.failedModel}`, {
					sessionID,
					staleModel: newModel,
					currentModel: preCheckState.currentModel,
				})
				deferredToOtherHandler = true
				return false
			}
		} else if (preCheckState && preCheckState.currentModel !== newModel) {
			logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, wanted ${newModel}`, {
				sessionID,
				staleModel: newModel,
				currentModel: preCheckState.currentModel,
			})
			deferredToOtherHandler = true
			return false
		}

		const modelParts = newModel.split("/")
		if (modelParts.length < 2) {
			logInfo(`Invalid model format (missing provider prefix): ${newModel}`)
			const state = sessionStates.get(sessionID)
			if (state?.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}
			return false
		}

		const fallbackModelObj = {
			providerID: modelParts[0],
			modelID: modelParts.slice(1).join("/"),
		}

		// ── TOP-LEVEL SESSION HANDLING ──
		// Decide whether to abort based on model state, not session type.
		//
		// Error-triggered sources (session.error, message.updated): the model
		// has already stopped — abort is unnecessary and harmful (for child
		// sessions it signals the parent that the child is done, causing an
		// empty response).
		//
		// Timeout (session.timeout): the caller already aborted because the
		// model was hung — just wait for propagation.
		//
		// Status sources (session.status, session.status.immediate): the model
		// is still in a provider retry loop — abort is needed to stop it.
		const modelAlreadyStopped = source === "session.error" || source === "message.updated"
		const callerAlreadyAborted = source === "session.timeout"
		// session.idle.silent-failure: the model went idle without producing
		// tokens.  No NEW abort is needed, but a recent abort (e.g. from
		// session.timeout or session.status) may still be propagating.
		// We must wait for propagation before sending the replay.
		const mayHaveRecentAbort = source === "session.idle.silent-failure"

		if (modelAlreadyStopped) {
			logInfo(`Skipping abort — model already stopped (${source})`, {
				sessionID,
				newModel,
			})
		} else if (callerAlreadyAborted || mayHaveRecentAbort) {
			const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID)
			const msSinceAbort = selfAbortTs ? Date.now() - selfAbortTs : undefined
			if (selfAbortTs && msSinceAbort !== undefined && msSinceAbort < POST_ABORT_DELAY_MS * 2) {
				logInfo(`Waiting for recent abort propagation (${source})`, {
					sessionID,
					msSinceAbort,
				})
				// Wait the remaining time until the abort propagation window closes
				const remainingMs = Math.max(0, POST_ABORT_DELAY_MS - msSinceAbort)
				if (remainingMs > 0) {
					await new Promise<void>((resolve) =>
						setTimeout(() => resolve(), remainingMs)
					)
				}
			} else if (callerAlreadyAborted) {
				logInfo(`Caller already aborted (${source}), waiting for propagation`, {
					sessionID,
				})
				await new Promise<void>((resolve) =>
					setTimeout(() => resolve(), POST_ABORT_DELAY_MS)
				)
			}
		} else {
			await abortSessionRequest(sessionID, `pre-fallback.${source}`)
			await new Promise<void>((resolve) =>
				setTimeout(() => resolve(), POST_ABORT_DELAY_MS)
			)
		}

		// Note: The caller holds sessionRetryInFlight. We do NOT manage it here.
		deps.sessionFirstTokenReceived.set(sessionID, false)
		let retryDispatched = false
		try {
			// ── COMPACTION SESSION: PROPAGATE FAILURE TO PARENT ──
			// Compaction sessions are internal OpenCode operations with a fixed
			// model binding.  Neither `session.command("compact")` nor
			// `promptAsync` with a model override can change the model on a
			// compaction session — OpenCode resolves the model from the session
			// config, ignoring the API parameter.
			//
			// Instead of retrying on this session, propagate the model failure
			// to the parent session's fallback state.  This ensures the parent
			// session switches to the fallback model for subsequent prompts.
			if (resolvedAgent === "compaction") {
				// Look up the model that actually failed on this compaction session.
				// Since we're inside autoRetryWithFallback, the plan's failedModel
				// is the model that errored.
				const failedModel = plan?.failedModel
				logInfo(`Compaction session failed — propagating model failure to parent (${source})`, {
					sessionID,
					failedModel,
				})

				// Compaction runs inline on the main session (not a child).
				// Commit the fallback on THIS session so the chat.message
				// hook applies the model override on the next user prompt.
				if (failedModel && plan) {
					const currentState = sessionStates.get(sessionID)
					if (currentState) {
						if (!currentState.failedModels.has(failedModel)) {
							currentState.failedModels.set(failedModel, Date.now())
						}
						const committed = commitFallback(currentState, plan)
						if (committed) {
							logInfo(`Committed fallback on compaction session for next prompt (${source})`, {
								sessionID,
								from: failedModel,
								to: plan.newModel,
								attemptCount: currentState.attemptCount,
							})
						}

						if (config.notify_on_fallback) {
							const fromName = failedModel.split("/").pop() || failedModel
							const toName = plan.newModel.split("/").pop() || plan.newModel
							await ctx.client.tui
								.showToast({
									body: {
										title: "Model Fallback",
										message: `${fromName} failed during compaction — next prompt will use ${toName}`,
										variant: "warning",
										duration: 5000,
									},
								})
								.catch(() => {})
						}
					}
				}

				return false
			}

			// ── NORMAL REPLAY DISPATCH PATH ──
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})
			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) {
				logError(`No messages found in session for auto-retry (${source})`, { sessionID })
			}

			// Prefer replaying the last user message.  In child subagent sessions,
			// the latest replayable prompt can be non-user (e.g. system/tool), so
			// fall back to the last non-assistant message with parts.
			//
			// Skip messages that ONLY contain "compaction" type parts — these are
			// compaction-internal messages that promptAsync cannot replay.  We need
			// the real user message that preceded the compaction attempt.
			let lastUserPartsRaw: any[] | undefined
			let lastNonAssistantPartsRaw: any[] | undefined

			for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
				const m = msgs?.[i]
				const role = ((m?.info?.role ?? (m as any)?.role ?? "") as string).toLowerCase()
				const parts = m?.parts ?? (m?.info?.parts as any[] | undefined)
				if (!parts || parts.length === 0) continue

				// Skip compaction-only messages: parts where every part is
				// type "compaction" (not replayable via promptAsync).
				const hasOnlyCompactionParts = parts.every(
					(p: any) => p.type === "compaction"
				)
				if (hasOnlyCompactionParts) continue

				if (!lastNonAssistantPartsRaw && role !== "assistant") {
					lastNonAssistantPartsRaw = parts
				}

				if (role === "user") {
					lastUserPartsRaw = parts
					break
				}
			}

			const replayPartsRaw = lastUserPartsRaw ?? lastNonAssistantPartsRaw
			const replaySource = lastUserPartsRaw ? "last-user" : lastNonAssistantPartsRaw ? "last-non-assistant" : "none"

			if (replayPartsRaw && replayPartsRaw.length > 0) {
				// Second stale check: re-verify after all async work (abort + delay +
				// message fetch).  Another handler may have advanced the state during
				// any of the awaits above.
				const postCheckState = sessionStates.get(sessionID)
				const expectedCurrentModel = plan ? plan.failedModel : newModel
				if (postCheckState && postCheckState.currentModel !== expectedCurrentModel) {
					logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${postCheckState.currentModel}, expected failed model ${expectedCurrentModel}`, {
						sessionID,
						staleModel: newModel,
						currentModel: postCheckState.currentModel,
					})
					deferredToOtherHandler = true
					return false
				}


				// If another handler already dispatched and is awaiting a result
				// for this session, skip the duplicate dispatch.
				if (sessionAwaitingFallbackResult.has(sessionID)) {
					logInfo(`Skipping duplicate fallback dispatch — another handler already dispatched (${source})`, {
						sessionID,
						model: newModel,
					})
					deferredToOtherHandler = true
					return false
				}

				// Claim the dispatch slot BEFORE any async work (promptAsync).
				// This prevents a second concurrent handler from also dispatching.
				// Cleared in the finally block if dispatch fails.
				sessionAwaitingFallbackResult.add(sessionID)

				logInfo(`Auto-retrying with fallback model (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
					replaySource,
				})

				// Cast raw parts to MessagePart (runtime parts may have any shape).
				// Filter out "compaction" type parts — these are internal to
				// OpenCode's compaction and not replayable via promptAsync.
				const allParts: MessagePart[] = replayPartsRaw.filter(
					(p): p is MessagePart =>
						typeof p.type === "string" && p.type !== "compaction"
				)

				logInfo(`Prepared replay payload (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
					replaySource,
					payload: summarizeParts(allParts),
				})

				if (allParts.length > 0) {
					// Build the send function that calls promptAsync
					const sendFn = async (parts: MessagePart[]): Promise<void> => {
						logInfo(`Dispatching fallback replay (${source})`, {
							sessionID,
							model: newModel,
							agent: resolvedAgent,
							payload: summarizeParts(parts),
						})
						await ctx.client.session.promptAsync({
							path: { id: sessionID },
							body: {
								...(resolvedAgent ? { agent: resolvedAgent } : {}),
								model: fallbackModelObj,
								parts,
							},
							query: { directory: ctx.directory },
						})
						logInfo(`Fallback replay accepted by host (${source})`, {
							sessionID,
							model: newModel,
							agent: resolvedAgent,
						})
					}

					const replayResult = await replayWithDegradation(allParts, sendFn)

					if (replayResult.success) {
						// Commit the fallback plan to state NOW — after the API call
						// actually succeeded. This prevents race conditions where
						// session.error sees an advanced state before any API call
						// was made.
						let commitSucceeded = true
						if (plan) {
							const stateToCommit = sessionStates.get(sessionID)
							if (stateToCommit) {
								const committed = commitFallback(stateToCommit, plan)
								if (committed) {
									logInfo(`Committed fallback state after successful dispatch (${source})`, {
										sessionID,
										newModel: plan.newModel,
										failedModel: plan.failedModel,
										attemptCount: stateToCommit.attemptCount,
									})
								} else {
									// Another handler already committed the same plan.
									// We've sent a duplicate replay that we can't un-send.
									// Abort it to prevent the provider from processing
									// two requests for the same session, then bail out
									// so we don't schedule a competing timeout.
									logInfo(`Fallback state already committed by another handler — aborting duplicate replay (${source})`, {
										sessionID,
										newModel: plan.newModel,
									})
									commitSucceeded = false
									await abortSessionRequest(sessionID, `duplicate-replay.${source}`)
								}
							}
						}

						if (!commitSucceeded) {
							// Let the handler that won the commit own the awaiting
							// state and timeout.  Mark ourselves as deferred.
							deferredToOtherHandler = true
							return false
						}

						// sessionAwaitingFallbackResult already set before dispatch
						scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
						retryDispatched = true

						logInfo(`Fallback replay succeeded (${source})`, {
							sessionID,
							tier: replayResult.tier,
							sentPartsCount: replayResult.sentParts?.length,
							droppedTypes: replayResult.droppedTypes,
							replaySource,
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
				logInfo(`No replayable non-assistant message found for auto-retry (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
				})
			}
		} catch (retryError) {
			logError(`Auto-retry failed (${source})`, {
				sessionID,
				error: String(retryError),
			})
			sessionAwaitingFallbackResult.delete(sessionID)
			deps.sessionCompactionInFlight.delete(sessionID)
			clearSessionFallbackTimeout(sessionID)
		} finally {
			// Note: sessionRetryInFlight is managed by the caller, not here.
			// Don't clear awaiting flag if we deferred to another handler that
			// IS dispatching — they own the flag now.
			if (!retryDispatched && !deferredToOtherHandler) {
				sessionAwaitingFallbackResult.delete(sessionID)
				deps.sessionCompactionInFlight.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				const state = sessionStates.get(sessionID)
				if (state?.pendingFallbackModel) {
					state.pendingFallbackModel = undefined
				}
			}
		}

		return retryDispatched
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
				deps.sessionParentID.delete(sessionID)
				deps.sessionIdleResolvers.delete(sessionID)
				deps.sessionLastMessageTime.delete(sessionID)
				deps.sessionCompactionInFlight.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				cleanedCount++
			}
		}
		if (cleanedCount > 0) {
			logInfo(`Cleaned up ${cleanedCount} stale session states`)
		}
	}

	return {
		getParentSessionID,
		abortSessionRequest,
		clearSessionFallbackTimeout,
		scheduleSessionFallbackTimeout,
		autoRetryWithFallback,
		resolveAgentForSessionFromContext,
		cleanupStaleSessions,
	}
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
