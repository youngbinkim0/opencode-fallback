import { describe, test, expect } from "bun:test"
import {
	createFallbackState,
	isModelInCooldown,
	findNextAvailableFallback,
	prepareFallback,
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
})
