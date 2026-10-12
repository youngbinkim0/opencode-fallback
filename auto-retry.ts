import type { HookDeps, MessagePart, FallbackPlan } from "./types"
import { logInfo, logError } from "./logger"
import { getFallbackModelsForSession, resolveAgentForSession } from "./config-reader"
import { prepareFallback, planFallback, commitFallback, createFallbackState, isModelInCooldown } from "./fallback-state"
import { acquireRetryLock, releaseRetryLock } from "./retry-lock"
import { replayWithDegradation } from "./message-replay"
import { FALLBACK_CONTINUATION_PROMPT } from "./continuation-prompt"

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
	const childFallbackBridges = new Map<
		string,
		{ parentID: string; startedAt: number; claimedByToolHook: boolean }
	>()
	const compactionDispatchOwners = new Map<string, { generation: number; model: string }>()
	let nextCompactionDispatchGeneration = 0
	const sessionDispatchModels = deps.sessionDispatchModels ??= new Map<string, string>()
	const ownsCompactionDispatch = (
		sessionID: string,
		owner: { generation: number; model: string } | undefined,
	) => Boolean(owner && compactionDispatchOwners.get(sessionID) === owner)
	const clearCompactionDispatch = (
		sessionID: string,
		owner: { generation: number; model: string } | undefined,
	) => {
		if (!ownsCompactionDispatch(sessionID, owner)) return false
		compactionDispatchOwners.delete(sessionID)
		deps.sessionCompactionInFlight.delete(sessionID)
		return true
	}

	const registerChildFallbackBridge = (childID: string, parentID: string) => {
		if (childFallbackBridges.has(childID)) return
		childFallbackBridges.set(childID, {
			parentID,
			startedAt: Date.now(),
			claimedByToolHook: false,
		})
		logInfo("Registered child fallback bridge", { childSession: childID, parentSession: parentID })
	}

	const clearChildFallbackBridge = (childID: string) => {
		const bridge = childFallbackBridges.get(childID)
		if (!bridge) return
		childFallbackBridges.delete(childID)
		logInfo("Cleared child fallback bridge", { childSession: childID, parentSession: bridge.parentID })
	}

	const claimChildFallbackBridge = (childID: string, parentID: string): number | undefined => {
		const bridge = childFallbackBridges.get(childID)
		if (!bridge || bridge.parentID !== parentID) return undefined
		bridge.claimedByToolHook = true
		return bridge.startedAt
	}

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

	const scheduleSessionFallbackTimeout = (
		sessionID: string,
		resolvedAgent?: string,
		compactionOwner?: { generation: number; model: string },
	) => {
		clearSessionFallbackTimeout(sessionID)

		const timeoutMs = config.timeout_seconds * 1000
		if (timeoutMs <= 0) return

		const timer = setTimeout(async () => {
			if (sessionFallbackTimeouts.get(sessionID) !== timer) return
			if (compactionOwner && !ownsCompactionDispatch(sessionID, compactionOwner)) return
			sessionFallbackTimeouts.delete(sessionID)
			if (compactionOwner && !deps.sessionCompactionInFlight.has(sessionID)) return

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
			if (compactionOwner) {
				clearCompactionDispatch(sessionID, compactionOwner)
				sessionAwaitingFallbackResult.delete(sessionID)
			} else {
				deps.sessionCompactionInFlight.delete(sessionID)
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
			// Abort/cleanup above can yield to another handler. Recheck immediately
			// before acquiring so this timeout never overwrites a newer owner.
			if (sessionRetryInFlight.has(sessionID)) {
				logInfo("Timeout recovery yielded to a retry started during abort", { sessionID })
				return
			}

			logInfo("Session fallback timeout reached", {
				sessionID,
				timeoutSeconds: config.timeout_seconds,
				currentModel: state.currentModel,
			})

			// Timeout callback owns only the lock token it acquires. A later
			// recovery dispatch may acquire a replacement while this callback is
			// still unwinding from a long summarize promise.
			const retryLockToken = acquireRetryLock(deps, sessionID)
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
				releaseRetryLock(deps, sessionID, retryLockToken)
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
		let compactionOwner: { generation: number; model: string } | undefined
		let normalDispatchModel: string | undefined
		// Callers own the lock. Snapshot that owner's token before yielding so
		// the summarize wait can release it without later touching a replacement.
		const retryLockToken = deps.sessionRetryLockTokens?.get(sessionID)

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

		// Claim compaction ownership before getParentSessionID() below can
		// yield. Timeout, status, and idle handlers may enter this function
		// concurrently for the same failed compaction.
		if (resolvedAgent === "compaction") {
			if (deps.sessionCompactionInFlight.has(sessionID)) {
				logInfo(`Skipping duplicate compaction fallback (${source})`, { sessionID })
				deferredToOtherHandler = true
				return false
			}
			deps.sessionCompactionInFlight.add(sessionID)
			compactionOwner = { generation: ++nextCompactionDispatchGeneration, model: newModel }
			compactionDispatchOwners.set(sessionID, compactionOwner)
		}

		// OpenCode's compaction processor prefers agent.compaction.model over
		// the model in session.summarize's body. Refuse a fallback that the host
		// would silently run on a different model, before aborting or deleting
		// any session messages. A stale request may overlap another handler's
		// dispatch; leave that handler's awaiting flag and timer untouched.
		if (resolvedAgent === "compaction") {
			const compactionConfig = deps.agentConfigs?.compaction
			const pinnedModel =
				typeof compactionConfig === "object" && compactionConfig !== null &&
					typeof (compactionConfig as Record<string, unknown>).model === "string"
						? ((compactionConfig as Record<string, unknown>).model as string)
						: undefined
			const pinnedModelInCooldown = Boolean(
				pinnedModel && pinnedModel === newModel && preCheckState &&
				isModelInCooldown(pinnedModel, preCheckState, config.cooldown_seconds)
			)
			if (pinnedModel && (pinnedModel !== newModel || pinnedModelInCooldown)) {
				clearCompactionDispatch(sessionID, compactionOwner)
				if (sessionAwaitingFallbackResult.has(sessionID)) {
					logInfo(`Skipping pinned compaction fallback (${source}); another handler owns the result`, {
						sessionID,
						pinnedModel,
						requestedModel: newModel,
					})
					deferredToOtherHandler = true
					return false
				}
				const reason = pinnedModelInCooldown
					? `Pinned compaction model ${pinnedModel} is still in fallback cooldown.`
					: `Compaction is pinned to ${pinnedModel}, so it cannot switch to ${newModel}.`
				const action = pinnedModelInCooldown
					? "Wait for the fallback cooldown or unset agent.compaction.model."
					: "Unset agent.compaction.model to allow switching compaction models."
				logError(reason, {
					sessionID,
					pinnedModel,
					requestedModel: newModel,
					action,
				})
				if (preCheckState) preCheckState.pendingFallbackModel = undefined
				sessionAwaitingFallbackResult.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				if (config.notify_on_fallback) {
					await ctx.client.tui
						.showToast({
							body: {
								title: "Compaction Fallback Blocked",
								message: `${reason} ${action}`,
								variant: "warning",
								duration: 10000,
							},
						})
						.catch(() => {})
				}
				return false
			}
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
		const modelAlreadyStopped =
			source === "session.error" ||
			source === "message.updated" ||
			source === "task.empty-result"
		const callerAlreadyAborted = source === "session.timeout"
		// session.idle.silent-failure: the model went idle without producing
		// tokens.  No NEW abort is needed, but a recent abort (e.g. from
		// session.timeout or session.status) may still be propagating.
		// We must wait for propagation before sending the replay.
		const mayHaveRecentAbort = source === "session.idle.silent-failure"
		const childParentID = await getParentSessionID(sessionID)
		if (childParentID) registerChildFallbackBridge(sessionID, childParentID)

		if (modelAlreadyStopped) {
			logInfo(`Skipping abort — model already stopped (${source}), waiting for session to settle`, {
				sessionID,
				newModel,
			})
			// Even though the model has stopped, the host's session may still
			// be transitioning from the error state.  Without a brief delay,
			// promptAsync can be accepted but never actually processed — the
			// session goes idle immediately without generating any output.
			// A small settling delay lets the host fully clean up before we
			// start a new prompt loop.
			await new Promise<void>((resolve) =>
				setTimeout(() => resolve(), POST_ABORT_DELAY_MS)
			)
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
			// ── COMPACTION FALLBACK: ABORT + SUMMARIZE ON FALLBACK MODEL ──
			// OpenCode's session.summarize endpoint:
			//  1. Calls SessionRevert.cleanup (undoes any revert state)
			//  2. Creates a NEW compaction via SessionCompaction.create with
			//     the model we specify (providerID + modelID)
			//  3. Runs SessionPrompt.loop to process it
			//
			// Key insight: summarize handles cleanup internally, so we don't
			// need to revert or delete messages ourselves.  We just need to
			// abort the stuck session and wait for it to settle, then call
			// summarize with the fallback model.
			if (resolvedAgent === "compaction") {
				const failedModel = plan?.failedModel
				logInfo(`Compaction fallback: abort + summarize on fallback (${source})`, {
					sessionID,
					failedModel,
					newModel,
				})

				if (failedModel && plan) {
					const currentState = sessionStates.get(sessionID)
					if (currentState) {
						if (!currentState.failedModels.has(failedModel)) {
							currentState.failedModels.set(failedModel, Date.now())
						}
					}
				}

				// Step 1: Abort the stuck session
				try {
					await abortSessionRequest(sessionID, "compaction-fallback")
				} catch {
					logError(`Failed to abort session for compaction fallback (${source})`, { sessionID })
				}

				// Step 2: Wait for abort to fully propagate.
				await new Promise<void>((resolve) => setTimeout(resolve, 500))

				// Step 3: Delete the failed compaction messages from the session.
				// session.summarize calls SessionPrompt.loop which processes
				// messages in order — if the old failed compaction messages remain,
				// the loop retries them on k2p5 instead of using our new model.
				// The DELETE /session/{id}/message/{messageID} endpoint removes
				// them permanently (not available as a typed SDK method, so we
				// use the SDK's internal HTTP client directly).
				try {
					const messagesResp = await ctx.client.session.messages({
						path: { id: sessionID },
						query: { directory: ctx.directory },
					})
					const msgs = messagesResp.data ?? []

					// Collect message IDs to delete: failed assistant + compaction user
					// Delete in reverse order (newest first) to avoid index shifts
					const deleteIDs: string[] = []
					for (let i = msgs.length - 1; i >= 0; i--) {
						const msg = msgs[i]
						const msgRole = msg.info?.role as string | undefined
						const msgError = msg.info?.error
						const msgID = msg.info?.id as string | undefined
						const parts = msg.parts ?? []
						const isCompactionMsg = parts.length > 0 &&
							parts.every((p: any) => p.type === "compaction")

						if (!msgID) continue

						// Failed assistant message
						if (msgRole === "assistant" && msgError) {
							deleteIDs.push(msgID)
							continue
						}

						// Compaction user message
						if (isCompactionMsg) {
							deleteIDs.push(msgID)
							break // stop after finding both
						}
					}

					// Use the SDK's internal client to make raw DELETE calls
					const rawClient = (ctx.client.session as any)?._client
					if (rawClient && deleteIDs.length > 0) {
						for (const msgID of deleteIDs) {
							logInfo(`Deleting compaction message (${source})`, {
								sessionID,
								messageID: msgID,
							})
							try {
								await rawClient.delete({
									url: "/session/{id}/message/{messageID}",
									path: { id: sessionID, messageID: msgID },
								})
								logInfo(`Deleted compaction message (${source})`, {
									sessionID,
									messageID: msgID,
								})
							} catch (delErr) {
								logError(`Failed to delete compaction message (${source})`, {
									sessionID,
									messageID: msgID,
									error: String(delErr),
								})
							}
						}
					} else if (deleteIDs.length > 0) {
						logError(`Cannot access raw SDK client for message deletion (${source})`, {
							sessionID,
							messageCount: deleteIDs.length,
						})
					}
				} catch (msgErr) {
					logError(`Failed during compaction message cleanup (${source})`, {
						sessionID,
						error: String(msgErr),
					})
				}

				// Small delay to let deletions settle
				await new Promise<void>((resolve) => setTimeout(resolve, 200))

				// Step 3b: A session.compacted event can land while we were
				// aborting, deleting messages and waiting above.  We set the
				// compaction-in-flight sentinel at the top of this block, so if
				// it is gone now, handleSessionCompacted cleared it — compaction
				// already succeeded and re-dispatching would start a redundant
				// compaction that nothing clears, arming a fallback timeout that
				// always fires and walks the whole model chain.
				if (!deps.sessionCompactionInFlight.has(sessionID)) {
					logInfo(`Compaction already completed while preparing fallback (${source})`, {
						sessionID,
						failedModel,
						newModel,
					})
					return false
				}

				// Step 4: Call session.summarize with the fallback model
				const handleSummarizeFailure = async (summarizeErr: unknown) => {
					if (!ownsCompactionDispatch(sessionID, compactionOwner)) return
					logError(`session.summarize failed (${source})`, {
						sessionID,
						model: newModel,
						error: String(summarizeErr),
					})
					sessionAwaitingFallbackResult.delete(sessionID)
					if (plan) {
						const currentState = sessionStates.get(sessionID)
						if (currentState && commitFallback(currentState, plan)) {
							logInfo(`Committed compaction fallback state as last resort (${source})`, {
								sessionID,
								from: plan.failedModel,
								to: plan.newModel,
							})
						}
					}
					clearCompactionDispatch(sessionID, compactionOwner)
					clearSessionFallbackTimeout(sessionID)
					sessionAwaitingFallbackResult.delete(sessionID)

					if (config.notify_on_fallback) {
						const fromName = (failedModel || "primary").split("/").pop()!
						const toName = newModel.split("/").pop() || newModel
						await ctx.client.tui
							.showToast({
								body: {
									title: "Compaction Failed",
									message: `${fromName} can't compact — try /compact after switching to ${toName}`,
									variant: "warning",
									duration: 10000,
								},
							})
							.catch(() => {})
					}
				}
				try {
					if (sessionAwaitingFallbackResult.has(sessionID)) {
						logInfo(`Skipping duplicate compaction summarize (${source})`, { sessionID })
						clearCompactionDispatch(sessionID, compactionOwner)
						deferredToOtherHandler = true
						return false
					}
					sessionAwaitingFallbackResult.add(sessionID)

					logInfo(`Dispatching session.summarize on fallback model (${source})`, {
						sessionID,
						providerID: fallbackModelObj.providerID,
						modelID: fallbackModelObj.modelID,
					})

					// Commit at dispatch start, before summarize can synchronously run
					// the session loop and emit session.compacted. Committing after that
					// callback would let a completed operation look stale to other
					// handlers and could advance state after completion.
					if (plan) {
						const stateToCommit = sessionStates.get(sessionID)
						if (stateToCommit && !commitFallback(stateToCommit, plan)) {
							logInfo(`Compaction fallback state advanced before dispatch (${source})`, {
								sessionID,
								from: plan.failedModel,
								to: plan.newModel,
								currentModel: stateToCommit.currentModel,
							})
							deferredToOtherHandler = true
							await abortSessionRequest(sessionID, `stale-compaction.${source}`)
							return false
						}
						if (stateToCommit) {
							logInfo(`Committed fallback at compaction dispatch (${source})`, {
								sessionID,
								from: plan.failedModel,
								to: plan.newModel,
								attemptCount: stateToCommit.attemptCount,
							})
						}
					}

					const summarizePromise = ctx.client.session.summarize({
						path: { id: sessionID },
						body: {
							providerID: fallbackModelObj.providerID,
							modelID: fallbackModelObj.modelID,
						},
						query: { directory: ctx.directory },
					})

					retryDispatched = true
					// The timeout is recovery ownership for the in-flight summarize
					// loop. Release the retry lock before waiting so the timer can
					// acquire it and dispatch the next candidate.
					if (ownsCompactionDispatch(sessionID, compactionOwner) &&
						deps.sessionCompactionInFlight.has(sessionID) &&
						sessionAwaitingFallbackResult.has(sessionID) &&
						!deps.sessionFirstTokenReceived.get(sessionID)) {
						scheduleSessionFallbackTimeout(sessionID, resolvedAgent, compactionOwner)
					}
					releaseRetryLock(deps, sessionID, retryLockToken)

					const summarizeResult = await summarizePromise

					// A session.compacted event may fire inside summarize, before the
					// host promise settles. It owns completion; never restore a timer
					// or clear state that a newer dispatch now owns.
					if (!ownsCompactionDispatch(sessionID, compactionOwner)) {
						deferredToOtherHandler = true
						return true
					}
					if (!deps.sessionCompactionInFlight.has(sessionID) ||
						!sessionAwaitingFallbackResult.has(sessionID)) {
						clearCompactionDispatch(sessionID, compactionOwner)
						deferredToOtherHandler = true
						return true
					}

					logInfo(`session.summarize response (${source})`, {
						sessionID,
						model: newModel,
						response: (JSON.stringify(summarizeResult) ?? "undefined").slice(0, 500),
					})
					const summarizeError = (summarizeResult as { error?: unknown } | undefined)?.error
					if (summarizeError) {
						throw new Error(
							`session.summarize returned an error: ${JSON.stringify(summarizeError).slice(0, 300)}`
						)
					}

					if (config.notify_on_fallback) {
						const fromName = (failedModel || "primary").split("/").pop()!
						const toName = newModel.split("/").pop() || newModel
						await ctx.client.tui
							.showToast({
								body: {
									title: "Compaction Fallback",
									message: `${fromName} failed — retrying compaction on ${toName}`,
									variant: "warning",
									duration: 5000,
								},
							})
							.catch(() => {})
					}

					logInfo(`Compaction re-dispatched via summarize (${source})`, {
						sessionID,
						model: newModel,
					})
					return true
				} catch (summarizeErr) {
					await handleSummarizeFailure(summarizeErr)
					deferredToOtherHandler = true
					return false
				}
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

				// Replay guard: the selected user/non-assistant history must be
				// replayable, but its original parts are NOT resent. The retry sends
				// a short continuation instead; the original message stays in history.
				const continuationParts: MessagePart[] = [
					{ type: "text", text: FALLBACK_CONTINUATION_PROMPT },
				]

				logInfo(`Prepared replay payload (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
					replaySource,
					payload: summarizeParts(continuationParts),
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
						const prompt = childParentID
							? ctx.client.session.prompt ?? ctx.client.session.promptAsync
							: ctx.client.session.promptAsync
						normalDispatchModel = newModel
						sessionDispatchModels?.set(sessionID, newModel)
						await prompt.call(ctx.client.session, {
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

					const replayResult = await replayWithDegradation(continuationParts, sendFn)

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

						if (sessionDispatchModels?.get(sessionID) === newModel) {
							sessionDispatchModels.delete(sessionID)
						}
						normalDispatchModel = undefined

						// A fast response may arrive before promptAsync settles. Do
						// not arm a timer after the response has already produced a
						// first token and transferred/cleared the awaiting state.
						if (deps.sessionFirstTokenReceived.get(sessionID)) {
							const state = sessionStates.get(sessionID)
							if (state?.pendingFallbackModel === newModel) state.pendingFallbackModel = undefined
							sessionAwaitingFallbackResult.delete(sessionID)
							clearSessionFallbackTimeout(sessionID)
						} else if (sessionAwaitingFallbackResult.has(sessionID)) {
							scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
						}
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
			const ownsCurrentDispatch = compactionOwner
				? ownsCompactionDispatch(sessionID, compactionOwner)
				: !sessionDispatchModels?.has(sessionID) || sessionDispatchModels.get(sessionID) === normalDispatchModel
			if (!ownsCurrentDispatch) {
				deferredToOtherHandler = true
				return false
			}
			logError(`Auto-retry failed (${source})`, {
				sessionID,
				error: String(retryError),
			})
			sessionAwaitingFallbackResult.delete(sessionID)
			if (compactionOwner) clearCompactionDispatch(sessionID, compactionOwner)
			clearSessionFallbackTimeout(sessionID)
		} finally {
			if (normalDispatchModel && sessionDispatchModels?.get(sessionID) === normalDispatchModel) {
				sessionDispatchModels.delete(sessionID)
			}
			// Note: sessionRetryInFlight is managed by the caller, not here.
			// Don't clear awaiting flag if we deferred to another handler that
			// IS dispatching — they own the flag now.
			const ownsCurrentDispatch = compactionOwner
				? ownsCompactionDispatch(sessionID, compactionOwner)
				: !sessionDispatchModels?.has(sessionID) || sessionDispatchModels.get(sessionID) === normalDispatchModel
			if (!retryDispatched && !deferredToOtherHandler && ownsCurrentDispatch) {
				sessionAwaitingFallbackResult.delete(sessionID)
				if (compactionOwner) clearCompactionDispatch(sessionID, compactionOwner)
				deps.sessionProviderRetrying?.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				const state = sessionStates.get(sessionID)
				if (state?.pendingFallbackModel) {
					state.pendingFallbackModel = undefined
				}
			}
			if (childParentID && !retryDispatched) {
				clearChildFallbackBridge(sessionID)
			}
		}

		return retryDispatched
	}

	const retryEmptyChildTask = async (sessionID: string, eventAgent?: string): Promise<boolean> => {
		const state = sessionStates.get(sessionID)
		if (!state || sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
			return false
		}

		const resolvedAgent = resolveAgentForSession(sessionID, eventAgent)
		const fallbackModels = getFallbackModelsForSession(
			sessionID,
			resolvedAgent,
			deps.agentConfigs,
			deps.globalFallbackModels,
		)
		const plan = planFallback(sessionID, state, fallbackModels, config)
		if (!plan.success) return false

		const retryLockToken = acquireRetryLock(deps, sessionID)
		try {
			return await autoRetryWithFallback(
				sessionID,
				plan.newModel,
				resolvedAgent,
				"task.empty-result",
				plan,
			)
		} finally {
			releaseRetryLock(deps, sessionID, retryLockToken)
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
				clearChildFallbackBridge(sessionID)
				sessionStates.delete(sessionID)
				sessionLastAccess.delete(sessionID)
				sessionRetryInFlight.delete(sessionID)
				deps.sessionRetryLockTokens?.delete(sessionID)
				sessionAwaitingFallbackResult.delete(sessionID)
				deps.sessionFirstTokenReceived.delete(sessionID)
				deps.sessionRequestMessages?.delete(sessionID)
				deps.sessionActiveRequests?.delete(sessionID)
				sessionDispatchModels.delete(sessionID)
				compactionDispatchOwners.delete(sessionID)
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
		retryEmptyChildTask,
		claimChildFallbackBridge,
		clearChildFallbackBridge,
		resolveAgentForSessionFromContext,
		cleanupStaleSessions,
	}
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
