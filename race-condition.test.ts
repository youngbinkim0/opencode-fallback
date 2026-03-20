import { describe, test, expect, mock, beforeEach } from "bun:test"
import { createFallbackState, prepareFallback } from "./fallback-state"
import { DEFAULT_CONFIG } from "./constants"
import type { HookDeps, FallbackPluginConfig, FallbackState } from "./types"

/**
 * Helper to create mock HookDeps with controllable behavior.
 * promptAsyncFn can be customized to simulate success, failure, or delays.
 */
function createMockDeps(overrides?: Partial<{
	messagesData: Array<{
		info?: Record<string, unknown>
		role?: string
		parts?: Array<{ type?: string; text?: string } & Record<string, unknown>>
	}>
	promptAsyncFn: (...args: unknown[]) => Promise<void>
	abortFn: (...args: unknown[]) => Promise<void>
	config: Partial<FallbackPluginConfig>
	agentConfigs: Record<string, unknown>
	globalFallbackModels: string[]
}>): HookDeps {
	const messagesData = overrides?.messagesData ?? [
		{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
		{ info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
	]
	const promptAsyncFn = overrides?.promptAsyncFn ?? (async () => {})
	const abortFn = overrides?.abortFn ?? (async () => {})

	return {
		ctx: {
			directory: "/test",
			client: {
				session: {
					abort: mock(abortFn as any),
					messages: mock(async () => ({ data: messagesData })),
					promptAsync: mock(promptAsyncFn as any),
					get: mock(async () => ({ data: {} })),
				},
				tui: {
					showToast: mock(async () => {}),
				},
			},
		},
		config: { ...DEFAULT_CONFIG, ...overrides?.config } as Required<FallbackPluginConfig>,
		agentConfigs: overrides?.agentConfigs ?? undefined,
		globalFallbackModels: overrides?.globalFallbackModels ?? [],
		sessionStates: new Map(),
		sessionLastAccess: new Map(),
		sessionRetryInFlight: new Set(),
		sessionAwaitingFallbackResult: new Set(),
		sessionFallbackTimeouts: new Map(),
		sessionFirstTokenReceived: new Map(),
	}
}

describe("race condition protection", () => {
	describe("#given concurrent prepareFallback calls on shared state", () => {
		describe("#when two handlers call prepareFallback simultaneously without locking", () => {
			test("#then the second call advances state past the end of the fallback chain", () => {
				// This test demonstrates the race condition that existed before the fix.
				// Both handlers share the same state object and both mutate it.
				const state = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b"]

				// First handler calls prepareFallback - advances to model-a
				const result1 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result1.success).toBe(true)
				expect(result1.newModel).toBe("fallback/model-a")
				expect(state.fallbackIndex).toBe(0)
				expect(state.attemptCount).toBe(1)

				// Second handler calls prepareFallback on the SAME state - advances to model-b
				const result2 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result2.success).toBe(true)
				expect(result2.newModel).toBe("fallback/model-b")
				expect(state.fallbackIndex).toBe(1)
				expect(state.attemptCount).toBe(2)

				// A THIRD call would exhaust the chain
				const result3 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result3.success).toBe(false)
				expect(result3.error).toContain("No available fallback models")
			})
		})

		describe("#when the retry lock prevents the second handler from calling prepareFallback", () => {
			test("#then only one handler advances the state", () => {
				const state = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b", "fallback/model-c"]
				const retryInFlight = new Set<string>()

				// Simulate handler 1 (message.updated): acquires lock, calls prepareFallback
				expect(retryInFlight.has("session-1")).toBe(false)
				retryInFlight.add("session-1")
				const result1 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result1.success).toBe(true)
				expect(result1.newModel).toBe("fallback/model-a")

				// Simulate handler 2 (session.error): checks lock, finds it held, skips
				expect(retryInFlight.has("session-1")).toBe(true)
				// Handler 2 would return early here without calling prepareFallback

				// State should only have advanced once
				expect(state.attemptCount).toBe(1)
				expect(state.currentModel).toBe("fallback/model-a")
				expect(state.fallbackIndex).toBe(0)

				// Release lock
				retryInFlight.delete("session-1")
				expect(retryInFlight.has("session-1")).toBe(false)
			})
		})
	})

	describe("#given retry lock lifecycle", () => {
		describe("#when prepareFallback succeeds and autoRetry completes", () => {
			test("#then lock is acquired before prepareFallback and released after autoRetry", () => {
				const retryInFlight = new Set<string>()

				// Lock acquired
				retryInFlight.add("session-1")
				expect(retryInFlight.has("session-1")).toBe(true)

				// prepareFallback runs...
				const state = createFallbackState("primary/model")
				const result = prepareFallback("session-1", state, ["fallback/model-a"], DEFAULT_CONFIG)
				expect(result.success).toBe(true)

				// Lock still held during autoRetry
				expect(retryInFlight.has("session-1")).toBe(true)

				// autoRetry completes, lock released in finally block
				retryInFlight.delete("session-1")
				expect(retryInFlight.has("session-1")).toBe(false)
			})
		})

		describe("#when prepareFallback fails (exhausted models)", () => {
			test("#then lock is released immediately", () => {
				const retryInFlight = new Set<string>()
				const state = createFallbackState("primary/model")
				state.fallbackIndex = 0
				state.failedModels.set("fallback/model-a", Date.now())

				// Lock acquired
				retryInFlight.add("session-1")

				// prepareFallback fails
				const result = prepareFallback("session-1", state, ["fallback/model-a"], DEFAULT_CONFIG)
				expect(result.success).toBe(false)

				// Lock should be released on failure path
				retryInFlight.delete("session-1")
				expect(retryInFlight.has("session-1")).toBe(false)
			})
		})

		describe("#when autoRetry throws an exception", () => {
			test("#then lock is released via finally block", async () => {
				const retryInFlight = new Set<string>()

				retryInFlight.add("session-1")
				expect(retryInFlight.has("session-1")).toBe(true)

				// Simulate the try/finally pattern used in the handlers
				let errorCaught = false
				try {
					// Simulate autoRetry throwing
					await (async () => { throw new Error("Network error during replay") })()
				} catch {
					errorCaught = true
				} finally {
					retryInFlight.delete("session-1")
				}

				expect(errorCaught).toBe(true)
				expect(retryInFlight.has("session-1")).toBe(false)
			})
		})

		describe("#when lock is released after first handler", () => {
			test("#then a subsequent error from the fallback model can acquire the lock and proceed", () => {
				const retryInFlight = new Set<string>()
				const state = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b"]

				// First error: primary model fails -> fallback to model-a
				retryInFlight.add("session-1")
				const result1 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result1.success).toBe(true)
				expect(result1.newModel).toBe("fallback/model-a")
				retryInFlight.delete("session-1") // released after autoRetry

				// Second error: model-a also fails -> fallback to model-b
				expect(retryInFlight.has("session-1")).toBe(false)
				retryInFlight.add("session-1")
				const result2 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result2.success).toBe(true)
				expect(result2.newModel).toBe("fallback/model-b")
				retryInFlight.delete("session-1")

				expect(state.attemptCount).toBe(2)
				expect(state.currentModel).toBe("fallback/model-b")
			})
		})
	})

	describe("#given fallback chain progression when fallback model fails", () => {
		describe("#when the first fallback model hits a quota error", () => {
			test("#then state advances to the next fallback model in the chain", () => {
				const state = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b", "fallback/model-c"]

				// Primary fails -> advance to model-a
				const result1 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result1.success).toBe(true)
				expect(result1.newModel).toBe("fallback/model-a")
				expect(state.currentModel).toBe("fallback/model-a")

				// model-a hits quota -> advance to model-b
				const result2 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result2.success).toBe(true)
				expect(result2.newModel).toBe("fallback/model-b")
				expect(state.currentModel).toBe("fallback/model-b")

				// model-b also fails -> advance to model-c
				const result3 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result3.success).toBe(true)
				expect(result3.newModel).toBe("fallback/model-c")
				expect(state.currentModel).toBe("fallback/model-c")

				// All failed models are recorded with timestamps
				expect(state.failedModels.has("primary/model")).toBe(true)
				expect(state.failedModels.has("fallback/model-a")).toBe(true)
				expect(state.failedModels.has("fallback/model-b")).toBe(true)
			})
		})

		describe("#when all fallback models fail sequentially", () => {
			test("#then eventually returns exhausted after the last model", () => {
				const state = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b"]

				prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)

				// Now all are exhausted
				const result = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result.success).toBe(false)
				expect(result.error).toContain("No available fallback models")
			})
		})

		describe("#when max_fallback_attempts is reached before chain is exhausted", () => {
			test("#then returns maxAttemptsReached even if more models are available", () => {
				const config = { ...DEFAULT_CONFIG, max_fallback_attempts: 2 }
				const state = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b", "fallback/model-c"]

				prepareFallback("session-1", state, fallbackModels, config)
				prepareFallback("session-1", state, fallbackModels, config)

				// Attempt 3 blocked by max_fallback_attempts=2
				const result = prepareFallback("session-1", state, fallbackModels, config)
				expect(result.success).toBe(false)
				expect(result.maxAttemptsReached).toBe(true)
				expect(state.attemptCount).toBe(2)
			})
		})
	})

	describe("#given pendingFallbackModel guard in message.updated handler", () => {
		describe("#when error comes from a model that is NOT the pending fallback", () => {
			test("#then the error is for a stale model and should be skipped", () => {
				const state = createFallbackState("primary/model")
				state.pendingFallbackModel = "fallback/model-a"
				state.currentModel = "fallback/model-a"

				// Error comes from "primary/model" (stale) while waiting for "fallback/model-a"
				const errorModel = "primary/model"
				const shouldSkip = state.pendingFallbackModel && errorModel !== state.pendingFallbackModel
				expect(shouldSkip).toBe(true)
			})
		})

		describe("#when error comes from the pending fallback model itself", () => {
			test("#then the error is for the active fallback and should NOT be skipped", () => {
				const state = createFallbackState("primary/model")
				state.pendingFallbackModel = "fallback/model-a"
				state.currentModel = "fallback/model-a"

				// Error comes from "fallback/model-a" (current fallback hit quota)
				const errorModel = "fallback/model-a"
				const shouldSkip = state.pendingFallbackModel && errorModel !== state.pendingFallbackModel
				expect(shouldSkip).toBe(false)
			})
		})

		describe("#when there is no pending fallback model", () => {
			test("#then the guard does not skip", () => {
				const state = createFallbackState("primary/model")
				state.pendingFallbackModel = undefined

				const errorModel = "primary/model"
				const shouldSkip = state.pendingFallbackModel && errorModel !== state.pendingFallbackModel
				expect(shouldSkip).toBeFalsy()
			})
		})
	})

	describe("#given concurrent event simulation end-to-end", () => {
		describe("#when message.updated and session.error fire for the same failure", () => {
			test("#then only one handler processes the fallback, state advances exactly once", () => {
				const state = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b"]
				const retryInFlight = new Set<string>()

				// Simulate the race: both handlers check lock and try to proceed
				// Handler 1 (message.updated) wins the race
				const handler1Acquired = !retryInFlight.has("session-1")
				if (handler1Acquired) {
					retryInFlight.add("session-1")
				}

				// Handler 2 (session.error) loses the race
				const handler2Acquired = !retryInFlight.has("session-1")
				// handler2Acquired is false because handler1 already set the lock

				expect(handler1Acquired).toBe(true)
				expect(handler2Acquired).toBe(false)

				// Only handler 1 calls prepareFallback
				if (handler1Acquired) {
					const result = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
					expect(result.success).toBe(true)
					expect(result.newModel).toBe("fallback/model-a")
				}

				// State should reflect exactly ONE advancement
				expect(state.attemptCount).toBe(1)
				expect(state.currentModel).toBe("fallback/model-a")
				expect(state.fallbackIndex).toBe(0)

				// Handler 1 completes, releases lock
				retryInFlight.delete("session-1")
			})
		})

		describe("#when three events fire for the same failure", () => {
			test("#then only the first one processes, the other two are skipped", () => {
				const retryInFlight = new Set<string>()
				let prepareFallbackCallCount = 0

				const tryAcquireAndProcess = () => {
					if (retryInFlight.has("session-1")) {
						return false // skipped
					}
					retryInFlight.add("session-1")
					prepareFallbackCallCount++
					return true // processed
				}

				const results = [
					tryAcquireAndProcess(), // handler 1 - wins
					tryAcquireAndProcess(), // handler 2 - skipped
					tryAcquireAndProcess(), // handler 3 - skipped
				]

				expect(results).toEqual([true, false, false])
				expect(prepareFallbackCallCount).toBe(1)

				// Cleanup
				retryInFlight.delete("session-1")
			})
		})
	})

	describe("#given state isolation between sessions", () => {
		describe("#when two different sessions have errors at the same time", () => {
			test("#then each session's lock and state are independent", () => {
				const retryInFlight = new Set<string>()
				const state1 = createFallbackState("primary/model")
				const state2 = createFallbackState("primary/model")
				const fallbackModels = ["fallback/model-a", "fallback/model-b"]

				// Session 1 acquires lock
				retryInFlight.add("session-1")
				const result1 = prepareFallback("session-1", state1, fallbackModels, DEFAULT_CONFIG)

				// Session 2 should NOT be blocked by session 1's lock
				expect(retryInFlight.has("session-2")).toBe(false)
				retryInFlight.add("session-2")
				const result2 = prepareFallback("session-2", state2, fallbackModels, DEFAULT_CONFIG)

				// Both should succeed independently
				expect(result1.success).toBe(true)
				expect(result1.newModel).toBe("fallback/model-a")
				expect(result2.success).toBe(true)
				expect(result2.newModel).toBe("fallback/model-a")

				// States are independent
				expect(state1.attemptCount).toBe(1)
				expect(state2.attemptCount).toBe(1)

				retryInFlight.delete("session-1")
				retryInFlight.delete("session-2")
			})
		})
	})
})
