import { describe, test, expect } from "bun:test"
import {
	readFallbackModels,
	resolveAgentForSession,
	getFallbackModelsForSession,
	normalizeFallbackModelsField,
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
			test("#then returns fallback models with primary model prepended", () => {
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

				// Primary model is prepended — first thing to try when current model fails
				expect(result).toEqual([
					"anthropic/claude-opus-4-6",
					"google/antigravity-claude-opus-4-6-thinking",
				])
			})
		})

		describe("#when fallback_models already contains the primary model", () => {
			test("#then does not duplicate the primary model", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/model-a", "anthropic/claude-opus-4-6"],
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents
				)

				expect(result).toEqual(["google/model-a", "anthropic/claude-opus-4-6"])
			})
		})

		describe("#when fallback_models is empty but primary model exists", () => {
			test("#then returns empty (primary not injected when no explicit fallbacks)", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: [],
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents
				)

				// Empty fallback_models = user didn't opt into fallback, don't inject primary
				expect(result).toEqual([])
			})
		})

		describe("#when no agent resolved and no global config", () => {
			test("#then returns empty array (no iterate-all-agents)", () => {
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

				// Should NOT fall back to opus's models — that was the old bug
				expect(result).toEqual([])
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

	describe("#given getFallbackModelsForSession with global config", () => {
		const globalModels = ["google/antigravity-claude-opus-4-6-thinking", "github-copilot/claude-opus-4.6"]

		describe("#when agent has per-agent fallback_models", () => {
			test("#then returns per-agent models with primary prepended, ignoring global", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/agent-specific-model"],
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents,
					globalModels
				)

				expect(result).toEqual(["anthropic/claude-opus-4-6", "google/agent-specific-model"])
			})
		})

		describe("#when agent has no per-agent config but global exists", () => {
			test("#then returns global fallback models", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents,
					globalModels
				)

				expect(result).toEqual(globalModels)
			})
		})

		describe("#when neither per-agent nor global config exists", () => {
			test("#then returns empty array", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents
				)

				expect(result).toEqual([])
			})
		})

		describe("#when per-agent has empty fallback_models and global exists", () => {
			test("#then returns global (empty per-agent does not override)", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: [],
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents,
					globalModels
				)

				expect(result).toEqual(globalModels)
			})
		})

		describe("#when agent is unresolved and global config exists", () => {
			test("#then returns global fallback models", () => {
				const result = getFallbackModelsForSession(
					"ses_a1b2c3",
					undefined,
					undefined,
					globalModels
				)

				expect(result).toEqual(globalModels)
			})
		})

		describe("#when agent is unresolved and no global config", () => {
			test("#then returns empty array", () => {
				const result = getFallbackModelsForSession(
					"ses_a1b2c3",
					undefined,
					undefined
				)

				expect(result).toEqual([])
			})
		})

		describe("#when global fallback is empty array", () => {
			test("#then returns empty array", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
					},
				}

				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents,
					[]
				)

				expect(result).toEqual([])
			})
		})

		describe("#when agents is undefined but global exists", () => {
			test("#then returns global fallback models", () => {
				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					undefined,
					globalModels
				)

				expect(result).toEqual(globalModels)
			})
		})
	})

	describe("#given normalizeFallbackModelsField adversarial inputs", () => {
		describe("#when value is null", () => {
			test("#then returns empty array", () => {
				expect(normalizeFallbackModelsField(null)).toEqual([])
			})
		})

		describe("#when value is undefined", () => {
			test("#then returns empty array", () => {
				expect(normalizeFallbackModelsField(undefined)).toEqual([])
			})
		})

		describe("#when value is a number", () => {
			test("#then returns empty array", () => {
				expect(normalizeFallbackModelsField(42)).toEqual([])
			})
		})

		describe("#when value is a boolean", () => {
			test("#then returns empty array", () => {
				expect(normalizeFallbackModelsField(true)).toEqual([])
			})
		})

		describe("#when value is an object (not array)", () => {
			test("#then returns empty array", () => {
				expect(normalizeFallbackModelsField({ foo: "bar" })).toEqual([])
			})
		})

		describe("#when value is 0 (falsy number)", () => {
			test("#then returns empty array", () => {
				expect(normalizeFallbackModelsField(0)).toEqual([])
			})
		})

		describe("#when value is empty string", () => {
			test("#then returns empty array (falsy)", () => {
				expect(normalizeFallbackModelsField("")).toEqual([])
			})
		})

		describe("#when array contains mixed types (strings and non-strings)", () => {
			test("#then filters out non-string items silently", () => {
				const mixed = ["google/model-a", 42, null, "openai/gpt-4o", undefined, { x: 1 }, true]
				const result = normalizeFallbackModelsField(mixed)
				expect(result).toEqual(["google/model-a", "openai/gpt-4o"])
			})
		})

		describe("#when array contains only non-string items", () => {
			test("#then returns empty array", () => {
				expect(normalizeFallbackModelsField([42, null, true, {}])).toEqual([])
			})
		})
	})

	describe("#given readFallbackModels adversarial agent configs", () => {
		describe("#when agent config is a string (not an object)", () => {
			test("#then returns empty array", () => {
				const agents = { opus: "not-an-object" }
				expect(readFallbackModels("opus", agents as any)).toEqual([])
			})
		})

		describe("#when agent config is a number", () => {
			test("#then returns empty array", () => {
				const agents = { opus: 42 }
				expect(readFallbackModels("opus", agents as any)).toEqual([])
			})
		})

		describe("#when agent config is null", () => {
			test("#then returns empty array", () => {
				const agents = { opus: null }
				expect(readFallbackModels("opus", agents as any)).toEqual([])
			})
		})

		describe("#when agent config is an array (not a plain object)", () => {
			test("#then returns empty array", () => {
				const agents = { opus: ["model-a", "model-b"] }
				expect(readFallbackModels("opus", agents as any)).toEqual([])
			})
		})

		describe("#when agents is empty object", () => {
			test("#then returns empty array", () => {
				expect(readFallbackModels("opus", {})).toEqual([])
			})
		})
	})

	describe("#given resolveAgentForSession edge cases", () => {
		describe("#when session ID is empty string", () => {
			test("#then returns undefined", () => {
				expect(resolveAgentForSession("")).toBeUndefined()
			})
		})

		describe("#when session ID contains only noise words", () => {
			test("#then returns undefined", () => {
				expect(resolveAgentForSession("ses_work_task_session")).toBeUndefined()
			})
		})

		describe("#when session ID segment is exactly 2 characters", () => {
			test("#then skips it (too short)", () => {
				expect(resolveAgentForSession("ab_cd_ef")).toBeUndefined()
			})
		})

		describe("#when session ID segment is exactly 3 characters", () => {
			test("#then returns it (minimum valid length)", () => {
				expect(resolveAgentForSession("ses_abc")).toBe("abc")
			})
		})

		describe("#when session ID contains alphanumeric segments", () => {
			test("#then skips segments with digits (alpha-only regex)", () => {
				// "gpt4" contains a digit, so it fails /^[a-z][a-z-]*$/
				expect(resolveAgentForSession("ses_gpt4_work")).toBeUndefined()
			})
		})

		describe("#when session ID contains hyphens in agent name", () => {
			test("#then splits on hyphens — hyphenated names become separate segments", () => {
				// "my-agent" is split into ["my", "agent"] — "my" is 2 chars (too short),
				// "agent" is not a noise word, so it matches
				expect(resolveAgentForSession("ses_my-agent_work")).toBe("agent")
			})
		})

		describe("#when explicit agent is whitespace-only", () => {
			test("#then falls through to session ID detection", () => {
				const result = resolveAgentForSession("ses_opus_task", "   ")
				expect(result).toBe("opus")
			})
		})

		describe("#when session ID uses slash separators", () => {
			test("#then splits on slashes and finds agent", () => {
				expect(resolveAgentForSession("workspace/opus/task")).toBe("workspace")
			})
		})

		describe("#when session ID has multiple valid segments", () => {
			test("#then returns the first valid non-noise segment", () => {
				// "ses" is noise, "builder" is first valid (>2 chars, alpha, not noise)
				expect(resolveAgentForSession("ses_builder_opus")).toBe("builder")
			})
		})
	})

	describe("#given getFallbackModelsForSession case sensitivity", () => {
		describe("#when event agent has different case than config key", () => {
			test("#then resolves correctly because resolveAgentForSession lowercases", () => {
				const agents = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/model-a"],
					},
				}

				// eventAgent "OPUS" → resolveAgentForSession returns "opus" → matches config key
				const result = getFallbackModelsForSession(
					"ses_123",
					"OPUS",
					agents,
					[]
				)

				// Primary model prepended as first fallback candidate
				expect(result).toEqual(["anthropic/claude-opus-4-6", "google/model-a"])
			})
		})

		describe("#when config key is uppercase but resolved agent is lowercase", () => {
			test("#then returns empty (config keys are case-sensitive)", () => {
				const agents = {
					OPUS: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/model-a"],
					},
				}

				// resolveAgentForSession returns "opus" (lowercase), but config key is "OPUS"
				const result = getFallbackModelsForSession(
					"ses_123",
					"opus",
					agents,
					[]
				)

				// agents["opus"] is undefined, so falls through
				expect(result).toEqual([])
			})
		})
	})
})
