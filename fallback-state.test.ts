import { describe, test, expect } from "bun:test"
import {
	createFallbackState,
	isModelInCooldown,
	findNextAvailableFallback,
	prepareFallback,
	planFallback,
	commitFallback,
	snapshotFallbackState,
	restoreFallbackState,
	recoverToOriginal,
} from "./fallback-state"
import { DEFAULT_CONFIG } from "./constants"
import type { FallbackState } from "./types"

describe("fallback-state", () => {
	describe("#given createFallbackState", () => {
		describe("#when called with an original model", () => {
			test("#then initializes with correct defaults", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")

				expect(state.originalModel).toBe("anthropic/claude-opus-4-6")
				expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
				expect(state.fallbackIndex).toBe(-1)
				expect(state.attemptCount).toBe(0)
				expect(state.failedModels.size).toBe(0)
				expect(state.pendingFallbackModel).toBeUndefined()
			})
		})
	})

	describe("#given isModelInCooldown", () => {
		describe("#when model failed recently within cooldown window", () => {
			test("#then returns true", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.failedModels.set("google/gemini-pro", Date.now())

				expect(isModelInCooldown("google/gemini-pro", state, 60)).toBe(true)
			})
		})

		describe("#when model failed long ago outside cooldown window", () => {
			test("#then returns false", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.failedModels.set("google/gemini-pro", Date.now() - 120_000)

				expect(isModelInCooldown("google/gemini-pro", state, 60)).toBe(false)
			})
		})

		describe("#when model has never failed", () => {
			test("#then returns false", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")

				expect(isModelInCooldown("google/gemini-pro", state, 60)).toBe(false)
			})
		})
	})

	describe("#given findNextAvailableFallback", () => {
		describe("#when there are available fallback models", () => {
			test("#then returns the next model after current index", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.fallbackIndex = -1

				const fallbackModels = ["google/model-a", "openai/model-b", "github/model-c"]
				const result = findNextAvailableFallback(state, fallbackModels, 60)

				expect(result).toBe("google/model-a")
			})
		})

		describe("#when current model is at index 0", () => {
			test("#then returns the model at index 1", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.fallbackIndex = 0

				const fallbackModels = ["google/model-a", "openai/model-b", "github/model-c"]
				const result = findNextAvailableFallback(state, fallbackModels, 60)

				expect(result).toBe("openai/model-b")
			})
		})

		describe("#when next model is in cooldown", () => {
			test("#then skips it and returns the one after", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.fallbackIndex = -1
				state.failedModels.set("google/model-a", Date.now())

				const fallbackModels = ["google/model-a", "openai/model-b"]
				const result = findNextAvailableFallback(state, fallbackModels, 60)

				expect(result).toBe("openai/model-b")
			})
		})

		describe("#when all remaining models are in cooldown", () => {
			test("#then returns undefined", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.fallbackIndex = -1
				state.failedModels.set("google/model-a", Date.now())
				state.failedModels.set("openai/model-b", Date.now())

				const fallbackModels = ["google/model-a", "openai/model-b"]
				const result = findNextAvailableFallback(state, fallbackModels, 60)

				expect(result).toBeUndefined()
			})
		})

		describe("#when all models have been tried", () => {
			test("#then returns undefined", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.fallbackIndex = 2

				const fallbackModels = ["google/model-a", "openai/model-b", "github/model-c"]
				const result = findNextAvailableFallback(state, fallbackModels, 60)

				expect(result).toBeUndefined()
			})
		})
	})

	describe("#given prepareFallback", () => {
		describe("#when there is an available fallback model", () => {
			test("#then advances to next model and returns success", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b"]

				const result = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)

				expect(result.success).toBe(true)
				expect(result.newModel).toBe("google/model-a")
				expect(state.currentModel).toBe("google/model-a")
				expect(state.attemptCount).toBe(1)
				expect(state.failedModels.has("anthropic/claude-opus-4-6")).toBe(true)
				expect(state.pendingFallbackModel).toBe("google/model-a")
			})
		})

		describe("#when max attempts have been reached", () => {
			test("#then returns failure with maxAttemptsReached", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.attemptCount = DEFAULT_CONFIG.max_fallback_attempts

				const fallbackModels = ["google/model-a"]
				const result = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)

				expect(result.success).toBe(false)
				expect(result.maxAttemptsReached).toBe(true)
				expect(result.error).toContain("Max fallback attempts")
			})
		})

		describe("#when no available fallback models exist", () => {
			test("#then returns failure", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.fallbackIndex = 1
				state.failedModels.set("google/model-a", Date.now())
				state.failedModels.set("openai/model-b", Date.now())

				const fallbackModels = ["google/model-a", "openai/model-b"]
				const result = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)

				expect(result.success).toBe(false)
				expect(result.error).toContain("No available fallback models")
			})
		})

		describe("#when called multiple times sequentially", () => {
			test("#then advances through the chain correctly", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b", "github/model-c"]

				const result1 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result1.success).toBe(true)
				expect(result1.newModel).toBe("google/model-a")
				expect(state.attemptCount).toBe(1)

				const result2 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result2.success).toBe(true)
				expect(result2.newModel).toBe("openai/model-b")
				expect(state.attemptCount).toBe(2)

				const result3 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
				expect(result3.success).toBe(true)
				expect(result3.newModel).toBe("github/model-c")
				expect(state.attemptCount).toBe(3)
			})
		})

		describe("#when prepareFallback records failed model timestamps", () => {
			test("#then the previously current model is added to failedModels", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b"]

				prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)

				expect(state.failedModels.has("anthropic/claude-opus-4-6")).toBe(true)
				const timestamp = state.failedModels.get("anthropic/claude-opus-4-6")!
				expect(Date.now() - timestamp).toBeLessThan(1000)
			})
		})
	})

	describe("#given recoverToOriginal", () => {
		describe("#when currentModel equals originalModel", () => {
			test("#then returns false (no-op, already on primary)", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")

				const result = recoverToOriginal(state, 60)

				expect(result).toBe(false)
			})
		})

		describe("#when originalModel is still in cooldown", () => {
			test("#then returns false (too early to recover)", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 1
				state.failedModels.set("anthropic/claude-opus-4-6", Date.now())

				const result = recoverToOriginal(state, 60)

				expect(result).toBe(false)
			})
		})

		describe("#when originalModel is NOT in cooldown and currentModel differs", () => {
			test("#then returns true", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 1
				state.failedModels.set("anthropic/claude-opus-4-6", Date.now() - 120_000)

				const result = recoverToOriginal(state, 60)

				expect(result).toBe(true)
			})
		})

		describe("#when recovery succeeds", () => {
			test("#then state.currentModel is reset to originalModel", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 1
				state.failedModels.set("anthropic/claude-opus-4-6", Date.now() - 120_000)

				recoverToOriginal(state, 60)

				expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
			})

			test("#then state.fallbackIndex is reset to -1", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 1
				state.failedModels.set("anthropic/claude-opus-4-6", Date.now() - 120_000)

				recoverToOriginal(state, 60)

				expect(state.fallbackIndex).toBe(-1)
			})

			test("#then state.attemptCount is reset to 0", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 2
				state.failedModels.set("anthropic/claude-opus-4-6", Date.now() - 120_000)

				recoverToOriginal(state, 60)

				expect(state.attemptCount).toBe(0)
			})

			test("#then state.pendingFallbackModel is cleared", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 1
				state.pendingFallbackModel = "google/model-a"
				state.failedModels.set("anthropic/claude-opus-4-6", Date.now() - 120_000)

				recoverToOriginal(state, 60)

				expect(state.pendingFallbackModel).toBeUndefined()
			})

			test("#then state.failedModels is preserved unchanged", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 1
				const failedTimestamp = Date.now() - 120_000
				state.failedModels.set("anthropic/claude-opus-4-6", failedTimestamp)
				state.failedModels.set("openai/model-b", Date.now() - 90_000)

				recoverToOriginal(state, 60)

				expect(state.failedModels.size).toBe(2)
				expect(state.failedModels.get("anthropic/claude-opus-4-6")).toBe(failedTimestamp)
				expect(state.failedModels.has("openai/model-b")).toBe(true)
			})
		})

		describe("#when recovery fails (returns false)", () => {
			test("#then entire state object is unchanged", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/model-a"
				state.fallbackIndex = 0
				state.attemptCount = 1
				state.pendingFallbackModel = "google/model-a"
				const failedTimestamp = Date.now()
				state.failedModels.set("anthropic/claude-opus-4-6", failedTimestamp)

				// Snapshot the state before call
				const snapshotCurrentModel = state.currentModel
				const snapshotFallbackIndex = state.fallbackIndex
				const snapshotAttemptCount = state.attemptCount
				const snapshotPending = state.pendingFallbackModel
				const snapshotFailedModelsSize = state.failedModels.size

				const result = recoverToOriginal(state, 60)

				expect(result).toBe(false)
				expect(state.currentModel).toBe(snapshotCurrentModel)
				expect(state.fallbackIndex).toBe(snapshotFallbackIndex)
				expect(state.attemptCount).toBe(snapshotAttemptCount)
				expect(state.pendingFallbackModel).toBe(snapshotPending)
				expect(state.failedModels.size).toBe(snapshotFailedModelsSize)
				expect(state.failedModels.get("anthropic/claude-opus-4-6")).toBe(failedTimestamp)
			})
		})
	})

	describe("#given planFallback", () => {
		describe("#when there is an available fallback model", () => {
			test("#then returns a plan without mutating state", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b"]

				const plan = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)

				expect(plan.success).toBe(true)
				if (plan.success) {
					expect(plan.newModel).toBe("google/model-a")
					expect(plan.failedModel).toBe("anthropic/claude-opus-4-6")
					expect(plan.newFallbackIndex).toBe(0)
				}
				// State must NOT be mutated
				expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
				expect(state.attemptCount).toBe(0)
				expect(state.failedModels.size).toBe(0)
				expect(state.fallbackIndex).toBe(-1)
			})
		})

		describe("#when max attempts have been reached", () => {
			test("#then returns failure with maxAttemptsReached", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.attemptCount = DEFAULT_CONFIG.max_fallback_attempts

				const plan = planFallback("ses_1", state, ["google/model-a"], DEFAULT_CONFIG)

				expect(plan.success).toBe(false)
				if (!plan.success) {
					expect(plan.maxAttemptsReached).toBe(true)
				}
			})
		})

		describe("#when no available fallback models exist", () => {
			test("#then returns failure", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.fallbackIndex = 1
				state.failedModels.set("google/model-a", Date.now())
				state.failedModels.set("openai/model-b", Date.now())

				const plan = planFallback("ses_1", state, ["google/model-a", "openai/model-b"], DEFAULT_CONFIG)

				expect(plan.success).toBe(false)
			})
		})

		describe("#when called twice without committing", () => {
			test("#then returns the same plan both times (state unchanged)", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b"]

				const plan1 = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)
				const plan2 = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)

				expect(plan1.success).toBe(true)
				expect(plan2.success).toBe(true)
				if (plan1.success && plan2.success) {
					expect(plan1.newModel).toBe(plan2.newModel)
					expect(plan1.failedModel).toBe(plan2.failedModel)
				}
			})
		})
	})

	describe("#given commitFallback", () => {
		describe("#when committing a valid plan", () => {
			test("#then updates state correctly and returns true", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b"]
				const plan = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)

				expect(plan.success).toBe(true)
				if (!plan.success) return

				const committed = commitFallback(state, plan)

				expect(committed).toBe(true)
				expect(state.currentModel).toBe("google/model-a")
				expect(state.attemptCount).toBe(1)
				expect(state.failedModels.has("anthropic/claude-opus-4-6")).toBe(true)
				expect(state.fallbackIndex).toBe(0)
				expect(state.pendingFallbackModel).toBeUndefined()
			})
		})

		describe("#when committing the same plan twice (idempotency)", () => {
			test("#then second commit returns false and state is unchanged", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b"]
				const plan = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)
				if (!plan.success) return

				const first = commitFallback(state, plan)
				expect(first).toBe(true)
				expect(state.attemptCount).toBe(1)

				const second = commitFallback(state, plan)
				expect(second).toBe(false)
				// attemptCount must NOT have incremented again
				expect(state.attemptCount).toBe(1)
				expect(state.currentModel).toBe("google/model-a")
			})
		})

		describe("#when plan + commit are used to advance through chain", () => {
			test("#then each step advances correctly", () => {
				const state = createFallbackState("anthropic/claude-opus-4-6")
				const fallbackModels = ["google/model-a", "openai/model-b", "github/model-c"]

				// Step 1
				const plan1 = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)
				expect(plan1.success).toBe(true)
				if (plan1.success) commitFallback(state, plan1)
				expect(state.currentModel).toBe("google/model-a")
				expect(state.attemptCount).toBe(1)

				// Step 2
				const plan2 = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)
				expect(plan2.success).toBe(true)
				if (plan2.success) {
					expect(plan2.failedModel).toBe("google/model-a")
					expect(plan2.newModel).toBe("openai/model-b")
					commitFallback(state, plan2)
				}
				expect(state.currentModel).toBe("openai/model-b")
				expect(state.attemptCount).toBe(2)

				// Step 3
				const plan3 = planFallback("ses_1", state, fallbackModels, DEFAULT_CONFIG)
				expect(plan3.success).toBe(true)
				if (plan3.success) {
					expect(plan3.newModel).toBe("github/model-c")
					commitFallback(state, plan3)
				}
				expect(state.attemptCount).toBe(3)
			})
		})
	})

	describe("#given snapshotFallbackState / restoreFallbackState", () => {
		test("#then snapshot captures and restore reverts state", () => {
			const state = createFallbackState("anthropic/claude-opus-4-6")
			state.currentModel = "google/model-a"
			state.fallbackIndex = 1
			state.attemptCount = 2
			state.failedModels.set("anthropic/claude-opus-4-6", 1000)
			state.pendingFallbackModel = "google/model-a"

			const snap = snapshotFallbackState(state)

			// Mutate state
			state.currentModel = "openai/model-b"
			state.fallbackIndex = 2
			state.attemptCount = 3
			state.failedModels.set("google/model-a", 2000)
			state.pendingFallbackModel = undefined

			restoreFallbackState(state, snap)

			expect(state.currentModel).toBe("google/model-a")
			expect(state.fallbackIndex).toBe(1)
			expect(state.attemptCount).toBe(2)
			expect(state.failedModels.size).toBe(1)
			expect(state.failedModels.has("anthropic/claude-opus-4-6")).toBe(true)
			expect(state.pendingFallbackModel).toBe("google/model-a")
		})
	})
})
