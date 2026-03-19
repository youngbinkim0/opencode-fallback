/**
 * Config reader for the standalone fallback plugin.
 *
 * Reads `fallback_models` from OpenCode's agent config section
 * (passed via the plugin config hook), NOT from oh-my-opencode.jsonc.
 */

type AgentRecord = Record<string, unknown>

const SESSION_ID_NOISE_WORDS = new Set(["ses", "work", "task", "session"])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeFallbackModelsField(
	value: unknown
): string[] {
	if (!value) return []
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string")
	}
	return []
}

export function readFallbackModels(
	agentName: string,
	agents: AgentRecord | undefined
): string[] {
	if (!agents) return []

	const agentConfig = agents[agentName]
	if (!isRecord(agentConfig)) return []

	return normalizeFallbackModelsField(agentConfig.fallback_models)
}

export function resolveAgentForSession(
	sessionID: string,
	eventAgent?: string
): string | undefined {
	if (eventAgent && eventAgent.trim().length > 0) {
		return eventAgent.trim().toLowerCase()
	}

	const segments = sessionID.split(/[\s_\-/]+/).filter(Boolean)
	for (const segment of segments) {
		const candidate = segment.toLowerCase()
		const isAlphaOnly = /^[a-z][a-z-]*$/.test(candidate)
		if (candidate.length > 2 && isAlphaOnly && !SESSION_ID_NOISE_WORDS.has(candidate)) {
			return candidate
		}
	}

	return undefined
}

export function getFallbackModelsForSession(
	sessionID: string,
	eventAgent: string | undefined,
	agents: AgentRecord | undefined,
	globalFallbackModels?: string[]
): string[] {
	const resolvedAgent = resolveAgentForSession(sessionID, eventAgent)

	// Tier 1: Per-agent fallback_models
	if (resolvedAgent && agents) {
		const models = readFallbackModels(resolvedAgent, agents)
		if (models.length > 0) return models
	}

	// Tier 2: Global fallback_models from plugin config
	if (globalFallbackModels && globalFallbackModels.length > 0) {
		return globalFallbackModels
	}

	// Tier 3: No fallback
	return []
}
