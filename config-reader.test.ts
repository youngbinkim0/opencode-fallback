import { describe, test, expect } from "bun:test"
import {
	readFallbackModels,
	resolveAgentForSession,
	getFallbackModelsForSession,
} from "./config-reader"

describe("config-reader", () => {
	describe("#given readFallbackModels", () => {
		describe("#when agent has fallback_models as array", () => {
			test("#then returns the array", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: [
							"google/antigravity-claude-opus-4-6-thinking",
							"github-copilot/claude-opus-4.6",
						],
					},
				}

				const result = readFallbackModels("opus", agents)

				expect(result).toEqual([
					"google/antigravity-claude-opus-4-6-thinking",
					"github-copilot/claude-opus-4.6",
				])
			})
		})

		describe("#when agent has fallback_models as single string", () => {
			test("#then normalizes to array", () => {
				const agents = {
					gemini: {
						model: "google/antigravity-gemini-3.1-pro",
						fallback_models: "github-copilot/gemini-3.1-pro-preview",
					},
				}

				const result = readFallbackModels("gemini", agents)

				expect(result).toEqual(["github-copilot/gemini-3.1-pro-preview"])
			})
		})

		describe("#when agent has no fallback_models", () => {
			test("#then returns empty array", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
					},
				}

				const result = readFallbackModels("opus", agents)

				expect(result).toEqual([])
			})
		})

		describe("#when agents config is undefined", () => {
			test("#then returns empty array", () => {
				const result = readFallbackModels("opus", undefined)

				expect(result).toEqual([])
			})
		})

		describe("#when agent name does not exist in config", () => {
			test("#then returns empty array", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/model"],
					},
				}

				const result = readFallbackModels("nonexistent", agents)

				expect(result).toEqual([])
			})
		})

		describe("#when fallback_models is empty array", () => {
			test("#then returns empty array", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: [],
					},
				}

				const result = readFallbackModels("opus", agents)

				expect(result).toEqual([])
			})
		})
	})

	describe("#given resolveAgentForSession", () => {
		describe("#when explicit agent parameter is provided", () => {
			test("#then returns normalized agent name", () => {
				const result = resolveAgentForSession(
					"ses_random_123",
					"Opus"
				)

				expect(result).toBe("opus")
			})
		})

		describe("#when explicit agent has leading/trailing whitespace", () => {
			test("#then returns trimmed lowercase name", () => {
				const result = resolveAgentForSession(
					"ses_random_123",
					"  Sonnet  "
				)

				expect(result).toBe("sonnet")
			})
		})

		describe("#when no explicit agent but session ID contains agent name", () => {
			test("#then detects agent from session ID", () => {
				const result = resolveAgentForSession("ses_opus_work_456")

				expect(result).toBe("opus")
			})
		})

		describe("#when no explicit agent and session ID has no recognizable pattern", () => {
			test("#then returns undefined", () => {
				const result = resolveAgentForSession("ses_a1b2c3_4d5e6f")

				expect(result).toBeUndefined()
			})
		})

		describe("#when explicit agent is empty string", () => {
			test("#then falls through to session ID detection", () => {
				const result = resolveAgentForSession("ses_sonnet_task", "")

				expect(result).toBe("sonnet")
			})
		})
	})

	describe("#given getFallbackModelsForSession", () => {
		describe("#when agent is resolved and has fallback models", () => {
			test("#then returns fallback models for the agent", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: [
							"google/antigravity-claude-opus-4-6-thinking",
						],
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents
				)

				expect(result).toEqual([
					"google/antigravity-claude-opus-4-6-thinking",
				])
			})
		})

		describe("#when no agent resolved but some agent has fallback models", () => {
			test("#then returns first agent's fallback models as default", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/model-a"],
					},
					sonnet: {
						model: "anthropic/claude-sonnet-4-6",
					},
				}

				const result = getFallbackModelsForSession(
					"ses_random_no_agent",
					undefined,
					agents
				)

				expect(result).toEqual(["google/model-a"])
			})
		})

		describe("#when no agent resolved and no agents have fallback models", () => {
			test("#then returns empty array", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
					},
				}

				const result = getFallbackModelsForSession(
					"ses_random_no_agent",
					undefined,
					agents
				)

				expect(result).toEqual([])
			})
		})

		describe("#when agents config is undefined", () => {
			test("#then returns empty array", () => {
				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					undefined
				)

				expect(result).toEqual([])
			})
		})
	})
})
