import type { Plugin } from "@opencode/plugin"
import { setTimeout as sleep } from "node:timers/promises"
import type { OpenCodeEvent } from "@opencode/client"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { FallbackPlan, FallbackPluginConfig, FallbackState } from "./types"
import { DEFAULT_CONFIG, PLUGIN_NAME } from "./constants"
import { loadPluginConfig } from "./plugin-config"
import { mergeAgentConfigs, normalizeFallbackModelsField, readFallbackModels } from "./config-reader"
import { createFallbackState, planFallback, commitFallback, isModelInCooldown } from "./fallback-state"
import { isRetryableError, isProviderWideRateLimitError } from "./error-classifier"
import { FALLBACK_CONTINUATION_PROMPT } from "./continuation-prompt"
import { logInfo, logError } from "./logger"
import { installV2ForegroundTaskFallback, readV2ForegroundSubagentOutput } from "./v2-foreground-task"
import { registerFallbackNotifications } from "./v2-notifications"
import { installV2CompactionFallback, type V2CompactionFallback } from "./v2-compaction"
import { BACKGROUND_RUNTIME } from "./v2-background-task"

declare const __FALLBACK_BUILD_ID__: string | undefined
export const V2_RUNTIME = Object.freeze({
	revision: "streaming-ttft-v3",
	moduleID: crypto.randomUUID(),
	buildID: typeof __FALLBACK_BUILD_ID__ === "string" ? __FALLBACK_BUILD_ID__ : "source",
})

/** Explicit plugin options override legacy fallback settings in OpenCode's agents. */
export interface V2FallbackConfig extends FallbackPluginConfig {
	agents?: Record<string, { fallback_models?: string | string[] }>
}

type ModelRef = Parameters<Plugin.Context["session"]["switchModel"]>[0]["model"]
type SessionState = {
	fallback: FallbackState
	agent: string
	messageID?: string
	requestToken?: symbol
	requestStartedAt?: number
	timer?: ReturnType<typeof setTimeout>
	pending?: FallbackPlan
	pendingBlockedProvider?: string
	pendingReady?: boolean
	pendingInterrupt?: boolean
	dispatch?: Promise<void>
	cancelled: boolean
	parentCancelled?: boolean
	expectedInterrupts: number
	active: boolean
	awaitingExecution: boolean
	recoveryFailed?: boolean
	ownedExecution?: boolean
	requestKind?: SessionHooks["model.request"]["kind"]
	lastAccess: number
}

export function parseModelRef(value: string): ModelRef {
	const slash = value.indexOf("/")
	if (slash < 1 || slash === value.length - 1) throw new Error(`Invalid fallback model: ${value}`)
	const [id, variant] = value.slice(slash + 1).split("#")
	if (!id) throw new Error(`Invalid fallback model: ${value}`)
	return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

function modelName(model: ModelRef): string {
	// V2 resolves an omitted variant to "default" before invoking hooks.
	// Treat those references as the same model to preserve chain/cooldown state.
	return `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`
}

async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw signal.reason
	let abort!: () => void
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason)
			signal.addEventListener("abort", abort, { once: true })
		})])
	} finally {
		signal.removeEventListener("abort", abort)
	}
}

export async function setupV2(ctx: Plugin.Context) {
	const file = loadPluginConfig<V2FallbackConfig>(ctx.location.directory)
	const options = ctx.options as V2FallbackConfig
	const config = { ...DEFAULT_CONFIG, ...file, ...options }
	if (!config.enabled) return
	const agents = { ...file.agents, ...options.agents }
	const resolvedAgents: Record<string, unknown> = {}
	const normalizeModels = (value: unknown) => normalizeFallbackModelsField(value).map((model) => modelName(parseModelRef(model)))
	const globalModels = normalizeModels(config.fallback_models)
	// Fail at load time rather than stopping a provider's retry for an invalid ref.
	for (const model of [...globalModels, ...Object.values(agents).flatMap((agent) => normalizeFallbackModelsField(agent.fallback_models))]) {
		parseModelRef(model)
	}
	const states = new Map<string, SessionState>()
	const controller = new AbortController()
	const registrations: Array<{ dispose(): Promise<void> }> = []
	let disposed = false
	let streamHealthy = true
	let compaction: V2CompactionFallback | undefined
	// "provider/model" → variant IDs for enabled models. undefined means the
	// inventory is untrusted, so no candidate is verified and native retry is kept.
	let inventory: Map<string, Set<string>> | undefined
	let inventoryUpdatedAt = 0
	let inventoryRequest: Promise<void> | undefined
	const refreshInventory = async (force = false) => {
		const ttl = inventory ? 30_000 : 5_000
		if (!force && inventoryUpdatedAt > 0 && Date.now() - inventoryUpdatedAt < ttl) return
		if (inventoryRequest) return inventoryRequest
		const request = (async () => {
			try {
				const lookupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
				const { data } = await withSignal(ctx.model.list({ location: { directory: ctx.location.directory } }), lookupSignal)
				inventory = new Map(data.filter((model) => model.enabled).map((model) => [
					`${model.providerID}/${model.modelID}`,
					new Set(model.variants.map((variant) => variant.id)),
				]))
			} catch (error) {
				inventory = undefined
				logError("V2 model inventory unavailable", { error: String(error) })
			} finally {
				inventoryUpdatedAt = Date.now()
			}
		})()
		inventoryRequest = request
		try {
			await request
		} finally {
			if (inventoryRequest === request) inventoryRequest = undefined
		}
	}
	const available = (name: string) => {
		if (!inventory) return false
		const { providerID, id, variant } = parseModelRef(name)
		const variants = inventory.get(`${providerID}/${id}`)
		return variants !== undefined && (!variant || variant === "default" || variants.has(variant))
	}
	const resolveAgentFallback = async (agentID: string) => {
		await refreshInventory()
		try {
			const lookupSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
			const { data: agent } = await withSignal(ctx.agent.get({ agentID, location: { directory: ctx.location.directory } }), lookupSignal)
			const models = normalizeFallbackModelsField(agent.request.body?.fallback_models).flatMap((model) => {
				try { return [modelName(parseModelRef(model))] } catch (error) {
					logError("V2 invalid legacy fallback model ignored", { agent: agentID, model, error: String(error) })
					return []
				}
			})
			const value = { model: agent.model && modelName(agent.model), fallback_models: models }
			if (JSON.stringify(resolvedAgents[agentID]) !== JSON.stringify(value)) {
				resolvedAgents[agentID] = value
				logInfo("V2 agent fallback configuration loaded", { directory: ctx.location.directory, agent: agentID, ...value })
			}
		} catch (error) {
			logError("V2 agent fallback configuration unavailable", { agent: agentID, error: String(error) })
		}
	}
	const notifications = await registerFallbackNotifications(ctx, config)
	registrations.push(notifications)
	const configuredChain = (agent: string) => {
		const merged = mergeAgentConfigs(resolvedAgents, agents)
		const models = normalizeModels(readFallbackModels(agent, merged))
		if (!models.length) return globalModels
		const primary = (merged?.[agent] as { model?: string } | undefined)?.model
		// Match v1: an opted-in agent can recover its configured primary when
		// the user manually selected a backup before the failure.
		if (primary && !models.includes(primary)) models.unshift(primary)
		return models
	}
	// Only host-listed candidates may suppress native retry or be switched to.
	const chain = (agent: string) => configuredChain(agent).filter(available)
	const clearTimer = (state: SessionState) => {
		clearTimeout(state.timer)
		state.timer = undefined
	}
	const clearPending = (state: SessionState) => {
		state.pending = undefined
		state.pendingBlockedProvider = undefined
	}
	const track = (sessionID: string, agent: string, model: ModelRef) => {
		const name = modelName(model)
		let state = states.get(sessionID)
		if (!state || (!state.pending && state.fallback.currentModel !== name)) {
			if (state) clearTimer(state)
			state = { fallback: createFallbackState(name), agent, cancelled: false, expectedInterrupts: 0, active: false, awaitingExecution: false, lastAccess: Date.now() }
			states.set(sessionID, state)
		}
		state.agent = agent
		state.lastAccess = Date.now()
		return state
	}
	const plan = (sessionID: string, state: SessionState, error: unknown, timeout = false) => {
		if (disposed || state.cancelled || !streamHealthy) return
		if (state.requestKind !== "primary") return
		if (!timeout && !isRetryableError(error, config.retry_on_errors, config.retryable_error_patterns)) return
		if (state.pending) return state.pending
		const blockedProvider = isProviderWideRateLimitError(error) ? state.fallback.currentModel.split("/")[0] : undefined
		const result = planFallback(sessionID, state.fallback, chain(state.agent), config, blockedProvider)
		if (!result.success) return
		state.pending = result
		state.pendingBlockedProvider = blockedProvider
		clearTimer(state)
		return result
	}
	const dispatch = (sessionID: string, state: SessionState, interrupt = false) => {
		if (!state.pending || state.cancelled || disposed) return
		state.pendingReady = true
		state.pendingInterrupt ||= interrupt
		if (state.dispatch) return
		let pending = state.pending
		state.recoveryFailed = false
		const shouldInterrupt = state.pendingInterrupt
		state.pendingReady = false
		state.pendingInterrupt = false
		// Never await session.wait from a hook or the event consumer: the host
		// must finish the failed execution and the stream must keep draining.
		state.dispatch = (async () => {
			if (shouldInterrupt) {
				state.expectedInterrupts++
				try {
					const result = await ctx.session.interrupt({ sessionID, resume: false }, { signal: controller.signal })
					if (!result.interrupted) state.expectedInterrupts = Math.max(0, state.expectedInterrupts - 1)
				} catch (error) {
					state.expectedInterrupts = Math.max(0, state.expectedInterrupts - 1)
					throw error
				}
			}
			await ctx.session.wait({ sessionID }, { signal: controller.signal })
			if (disposed || state.cancelled || state.pending !== pending) return
			// Recheck immediately before persisting: the host model inventory may have
			// changed since the synchronous retry hook admitted this candidate.
			await refreshInventory(true)
			if (disposed || state.cancelled || state.pending !== pending) return
			if (!available(pending.newModel)) {
				const refreshed = planFallback(sessionID, state.fallback, chain(state.agent), config, state.pendingBlockedProvider)
				if (!refreshed.success) {
					clearPending(state)
					state.active = false
					state.awaitingExecution = false
					state.recoveryFailed = true
					return
				}
				pending = refreshed
				state.pending = refreshed
			}
			await ctx.session.switchModel({ sessionID, model: parseModelRef(pending.newModel) }, { signal: controller.signal })
			if (disposed || state.cancelled || state.pending !== pending) return
			// Commit before prompt admission: new step events can arrive before
			// the admission promise returns, and must see the selected model.
			commitFallback(state.fallback, pending)
			state.ownedExecution = true
			clearPending(state)
			state.messageID = undefined
			state.active = false
			state.requestToken = undefined
			state.awaitingExecution = true
			state.requestStartedAt = Date.now()
			await ctx.session.prompt({ sessionID, text: FALLBACK_CONTINUATION_PROMPT, resume: true,
				metadata: { [PLUGIN_NAME]: true } }, { signal: controller.signal })
			// A parent's first interrupt may have raced with prompt admission.
			// Once admission resolves, cancel the now-existing execution again.
			if (state.cancelled || state.parentCancelled) {
				await withSignal(ctx.session.interrupt({ sessionID, resume: false }), controller.signal)
				return
			}
			logInfo("V2 fallback dispatched", { sessionID, from: pending.failedModel, model: pending.newModel })
			void notifications.notify({ sessionID, from: pending.failedModel, to: pending.newModel, kind: "primary" })
		})().catch((error) => {
			if (!disposed) logError("V2 fallback dispatch failed", { sessionID, error: String(error) })
			if (!state.pending || state.pending === pending) {
				clearPending(state)
				state.active = false
				state.awaitingExecution = false
				state.recoveryFailed = true
			}
		}).finally(() => {
			state.dispatch = undefined
			if (state.pendingReady) dispatch(sessionID, state, state.pendingInterrupt)
		})
	}
	const startRequest = (sessionID: string, state: SessionState) => {
		clearTimer(state)
		state.messageID = undefined
		state.cancelled = false
		state.active = true
		state.awaitingExecution = false
		state.recoveryFailed = false
		state.requestKind = "primary"
		state.requestStartedAt = Date.now()
		const token = Symbol("request")
		state.requestToken = token
		if (config.timeout_seconds <= 0 || !chain(state.agent).length) return
		state.timer = setTimeout(() => {
			if (state.requestToken !== token || state.cancelled) return
			logInfo("V2 first-token window expired", { sessionID, messageID: state.messageID })
			if (plan(sessionID, state, undefined, true)) dispatch(sessionID, state, true)
		}, config.timeout_seconds * 1000)
		state.timer.unref()
	}

	const retry = (event: SessionHooks["retry"]) => {
		const state = states.get(event.sessionID)
		if (!state || state.requestKind !== "primary" || state.agent !== event.agent || state.fallback.currentModel !== modelName(event.model)) return
		if (plan(event.sessionID, state, event.error)) event.decision = { retry: false }
		else if (!disposed && !state.cancelled && streamHealthy && state.ownedExecution &&
			isRetryableError(event.error, config.retry_on_errors, config.retryable_error_patterns)) {
			// Once recovery owns this turn, exhaustion must reach the host's final
			// failure instead of starting another native backoff loop on the last model.
			// The execution.failed event remains authoritative for final delivery.
			event.decision = { retry: false }
		}
	}
	const prompt = async (event: SessionHooks["prompt"]) => {
		if (event.metadata?.[PLUGIN_NAME]) return
		const state = states.get(event.sessionID)
		if (state) state.parentCancelled = false
		// Steer/queue admission can happen while a model is still running.
		// Recovery belongs to the next user turn, not the active request.
		if (!state || state.active || state.dispatch) return
		try {
			clearTimer(state)
			clearPending(state)
			state.cancelled = false
			state.parentCancelled = false
			state.lastAccess = Date.now()
			const current = await ctx.session.get({ sessionID: event.sessionID })
			if (current.model && modelName(current.model) !== state.fallback.currentModel) {
				states.delete(event.sessionID)
				return
			}
			const original = state.fallback.originalModel
			if (original !== state.fallback.currentModel && !isModelInCooldown(original, state.fallback, config.cooldown_seconds)) {
				await ctx.session.switchModel({ sessionID: event.sessionID, model: parseModelRef(original) })
				state.fallback = createFallbackState(original)
			} else {
				state.fallback.attemptCount = 0
				state.fallback.fallbackIndex = -1
			}
		} catch (error) {
			logError("V2 cooldown recovery failed", { sessionID: event.sessionID, error: String(error) })
		}
	}
	const handleEvent = (event: OpenCodeEvent) => {
		if (event.location && (event.location.directory !== ctx.location.directory ||
			("workspaceID" in event.location && event.location.workspaceID !== ctx.location.workspaceID))) return
		if (event.type === "model.updated" || event.type === "provider.updated") {
			void refreshInventory(true)
			return
		}
		compaction?.handleEvent(event)
		const data = event.data
		if (!("sessionID" in data)) return
		const sessionID = data.sessionID
		if (compaction?.isInternal(sessionID)) return
		if (event.type === "session.step.started") {
			if (!event.location && !states.has(sessionID)) return
			const state = track(sessionID, event.data.agent, event.data.model)
			if (state.messageID === event.data.assistantMessageID) return
			// Some hosts emit step.started only once the stream starts. Start
			// the deadline in the context hook so a stream with no first frame
			// cannot evade TTFT; bind its durable ID here without resetting it.
			if (!state.requestToken) startRequest(sessionID, state)
			state.messageID = event.data.assistantMessageID
			return
		}
		const state = states.get(sessionID)
		if (!state) return
		state.lastAccess = Date.now()
		if ("assistantMessageID" in data && data.assistantMessageID !== state.messageID) return
		if (event.type === "session.text.delta" || event.type === "session.reasoning.delta" || event.type === "session.tool.input.delta") {
			if (event.data.delta.length) clearTimer(state)
		} else if (event.type === "session.text.started" || event.type === "session.reasoning.started" ||
			event.type === "session.tool.input.started" || event.type === "session.tool.called" || event.type === "session.step.ended") {
			// Native hosts can publish a tool-input start without forwarding its
			// argument deltas. The start already proves model output has arrived;
			// TTFT must not interrupt the remainder of that healthy stream.
			clearTimer(state)
		} else if (event.type === "session.step.failed") {
			clearTimer(state)
			plan(sessionID, state, event.data.error)
		} else if (event.type === "session.execution.failed") {
			clearTimer(state)
			state.active = false
			state.awaitingExecution = false
			state.requestToken = undefined
			if (plan(sessionID, state, event.data.error)) dispatch(sessionID, state)
			else {
				state.ownedExecution = false
				if (!state.dispatch) clearPending(state)
			}
		} else if (event.type === "session.execution.interrupted" || event.type === "session.deleted") {
			if (event.type === "session.execution.interrupted" && state.expectedInterrupts > 0) {
				state.expectedInterrupts--
				return
			}
			clearTimer(state)
			state.active = false
			state.cancelled = true
			state.ownedExecution = false
			state.awaitingExecution = false
			clearPending(state)
			state.pendingReady = false
			if (event.type === "session.deleted") states.delete(sessionID)
		} else if (event.type === "session.idle" || event.type === "session.execution.succeeded") {
			// The old execution's idle can arrive after fallback admission.
			if (state.dispatch || state.awaitingExecution || (state.requestStartedAt !== undefined && event.created < state.requestStartedAt)) return
			clearTimer(state)
			state.active = false
			state.requestToken = undefined
			clearPending(state)
			state.pendingReady = false
			state.expectedInterrupts = 0
			state.ownedExecution = false
		} else if (event.type === "session.compaction.failed") {
			// Compaction recovery injects a summary through its own hook;
			// never continue a failed compaction as an ordinary prompt.
			clearTimer(state)
			state.requestKind = "compaction"
			clearPending(state)
		}
	}
	try {
		compaction = await installV2CompactionFallback(ctx, {
			config,
			childAgent: () => "compaction",
			streamHealthy: () => streamHealthy,
			chain: async (agent) => {
				await resolveAgentFallback("compaction")
				// V1 compaction-specific chains take precedence over the parent
				// agent. Explicit empty overrides still select the global chain.
				if (Object.hasOwn(agents, "compaction") || normalizeFallbackModelsField(readFallbackModels("compaction", resolvedAgents)).length) return chain("compaction")
				if (agent !== "compaction") await resolveAgentFallback(agent)
				return chain(agent)
			},
			notify: notifications.notify,
			clearMainTimer: (sessionID) => {
				const state = states.get(sessionID)
				if (state) { clearTimer(state); state.requestKind = "compaction" }
			},
		})
		registrations.push(compaction)
		if (config.foreground_task_fallback) {
			registrations.push(await installV2ForegroundTaskFallback(ctx, {
				isCancelled: (sessionID) => states.get(sessionID)?.cancelled === true,
				cancelFallback: (sessionID) => {
					compaction?.cancel(sessionID)
					const state = states.get(sessionID)
					if (!state) return
					clearTimer(state)
					state.cancelled = true
					state.parentCancelled = true
					clearPending(state)
					state.pendingReady = false
					state.active = false
					state.awaitingExecution = false
					state.requestToken = undefined
				},
				ownsFallback: (sessionID) => {
					const state = states.get(sessionID)
					return Boolean(state && !state.cancelled && (state.pending || state.dispatch || state.fallback.attemptCount > 0 || (state.active && chain(state.agent).length)))
				},
				async waitForFallback(sessionID, signal) {
					const abort = AbortSignal.any([signal, controller.signal])
					while (!abort.aborted) {
						const state = states.get(sessionID)
						if (!state || state.cancelled || state.recoveryFailed || disposed) return
						if (!state.pending && !state.dispatch && !state.awaitingExecution) {
							const current = await withSignal(ctx.session.get({ sessionID }), abort)
							// Check ownership again: another failure may have queued a
							// new continuation while this read was in flight.
							if (!state.pending && !state.dispatch && !state.awaitingExecution && !state.cancelled && !abort.aborted) {
								const hostIdle = current.time?.idle !== undefined && current.time.idle >= (state.requestStartedAt ?? 0)
								const terminal = hostIdle || (!state.active && current.time?.idle === undefined)
								if (state.fallback.attemptCount > 0 && current.outcome === "succeeded" && terminal) {
									return withSignal(readV2ForegroundSubagentOutput(ctx, sessionID), abort)
								}
								if (current.outcome && terminal) return
							}
						}
						try { await sleep(50, undefined, { signal: abort }) } catch { return }
					}
				},
			}))
		}
		registrations.push(await ctx.session.hook("context", async (event) => {
			if (disposed || compaction?.isInternal(event.sessionID)) return
			if (states.get(event.sessionID)?.parentCancelled) {
				void ctx.session.interrupt({ sessionID: event.sessionID, resume: false }).catch((error) => {
					if (!disposed) logError("V2 cancelled child interrupt failed", { sessionID: event.sessionID, error: String(error) })
				})
				return
			}
			const state = track(event.sessionID, event.agent, event.model)
			clearTimer(state)
			state.cancelled = false
			state.active = true
			state.awaitingExecution = false
			state.requestStartedAt = Date.now()
			const token = Symbol("context")
			state.requestToken = token
			// Fetch after host config/Markdown transforms have finished. V2 moves
			// legacy arbitrary agent fields into request.body; the resolved API
			// preserves OpenCode's project/global/env precedence and reloads.
			await resolveAgentFallback(event.agent)
			if (!disposed && !state.cancelled && states.get(event.sessionID) === state && state.requestToken === token) {
				startRequest(event.sessionID, state)
			}
		}))
		registrations.push(await ctx.session.hook("model.request", (event) => {
			const state = states.get(event.sessionID)
			if (state && state.fallback.currentModel === modelName(event.model)) {
				// Title/generate can run concurrently with the primary request.
				// Their arrival must not steal its retry ownership or TTFT window.
				if (state.active && event.kind !== "primary" && event.kind !== "compaction") return
				state.requestKind = event.kind
				if (event.kind === "compaction") clearTimer(state)
			}
		}))
		registrations.push(await ctx.session.hook("retry", retry))
		registrations.push(await ctx.session.hook("prompt", prompt))
	} catch (error) {
		await Promise.all(registrations.map((registration) => registration.dispose()))
		throw error
	}
	void (async () => {
		while (!disposed) {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					streamHealthy = true
					handleEvent(event)
				}
			} catch (error) {
				if (!disposed) logError("V2 fallback event subscription failed", { error: String(error) })
			}
			streamHealthy = false
			// Missing cancellation/progress events cannot leave a child generating.
			compaction?.cancelAll()
			for (const state of states.values()) {
				clearTimer(state)
				state.active = false
				state.awaitingExecution = false
				if (!state.dispatch) clearPending(state)
			}
			try { await sleep(1000, undefined, { signal: controller.signal }) } catch { break }
		}
	})()
	const cleanupInterval = setInterval(() => {
		for (const [id, state] of states) {
			if (!state.active && !state.awaitingExecution && !state.dispatch && !state.timer && Date.now() - state.lastAccess > 30 * 60 * 1000) states.delete(id)
		}
	}, 5 * 60 * 1000)
	cleanupInterval.unref()
	logInfo("V2 fallback plugin initialized", {
		directory: ctx.location.directory, models: globalModels,
		runtime: V2_RUNTIME, backgroundRuntime: BACKGROUND_RUNTIME, generationID: crypto.randomUUID(),
	})
	return async () => {
		disposed = true
		controller.abort()
		clearInterval(cleanupInterval)
		for (const state of states.values()) { state.cancelled = true; clearTimer(state) }
		states.clear()
		await Promise.all(registrations.map((registration) => registration.dispose()))
	}
}

const definition: Plugin.Plugin = { id: PLUGIN_NAME, setup: setupV2 }
export default {
	...definition,
	// V1 >=1.18.29 understands object entrypoints. Lazy import keeps its
	// runtime/schema helpers out of the V2 setup path.
	async server(...args: Parameters<typeof import("./v1").default>) {
		return (await import("./v1")).default(...args)
	},
}
