import type {
	PluginContext,
	FallbackPluginConfig,
	HookDeps,
	ChatMessageInput,
	ChatMessageOutput,
} from "./types"
import { DEFAULT_CONFIG, PLUGIN_NAME } from "./constants"
import { createAutoRetryHelpers } from "./auto-retry"
import { createEventHandler } from "./event-handler"
import { createMessageUpdateHandler } from "./message-update-handler"
import { createChatMessageHandler } from "./chat-message-handler"
import { normalizeFallbackModelsField } from "./config-reader"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { logInfo } from "./logger"

declare function setInterval(
	callback: () => void,
	delay: number
): { unref: () => void } & ReturnType<typeof globalThis.setInterval>

function loadPluginConfig(directory: string): Partial<FallbackPluginConfig> {
	const configPaths = [
		join(directory, ".opencode", "opencode-fallback.json"),
		join(directory, ".opencode", "opencode-fallback.jsonc"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.json"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.jsonc"),
	]

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8")
				// Strip JSONC comments
				const jsonContent = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
				return JSON.parse(jsonContent) as Partial<FallbackPluginConfig>
			} catch {
				logInfo(`[${PLUGIN_NAME}] Failed to parse config: ${configPath}`)
			}
		}
	}

	return {}
}

export default async function OpenCodeFallbackPlugin(
	ctx: PluginContext,
	configOverrides?: Partial<FallbackPluginConfig>
) {
	let agentConfigs: Record<string, unknown> | undefined
	let fileConfig: Partial<FallbackPluginConfig> = loadPluginConfig(ctx.directory)
	let mergedConfig: Required<FallbackPluginConfig> | undefined
	const globalFallbackModels = normalizeFallbackModelsField(fileConfig.fallback_models)

	// Config getter that builds config on first access
	const getConfig = (): Required<FallbackPluginConfig> => {
		if (!mergedConfig) {
			mergedConfig = {
				enabled:
					configOverrides?.enabled ??
					fileConfig?.enabled ??
					DEFAULT_CONFIG.enabled,
				retry_on_errors:
					configOverrides?.retry_on_errors ??
					fileConfig?.retry_on_errors ??
					DEFAULT_CONFIG.retry_on_errors,
				max_fallback_attempts:
					configOverrides?.max_fallback_attempts ??
					fileConfig?.max_fallback_attempts ??
					DEFAULT_CONFIG.max_fallback_attempts,
				cooldown_seconds:
					configOverrides?.cooldown_seconds ??
					fileConfig?.cooldown_seconds ??
					DEFAULT_CONFIG.cooldown_seconds,
					timeout_seconds:
					configOverrides?.timeout_seconds ??
					fileConfig?.timeout_seconds ??
					DEFAULT_CONFIG.timeout_seconds,
				notify_on_fallback:
					configOverrides?.notify_on_fallback ??
					fileConfig?.notify_on_fallback ??
					DEFAULT_CONFIG.notify_on_fallback,
			}
		}
		return mergedConfig
	}

	const deps: HookDeps = {
		ctx,
		get config() {
			return getConfig()
		},
		get agentConfigs() {
			return agentConfigs
		},
		globalFallbackModels,
		sessionStates: new Map(),
		sessionLastAccess: new Map(),
		sessionRetryInFlight: new Set(),
		sessionAwaitingFallbackResult: new Set(),
		sessionFallbackTimeouts: new Map(),
	}

	const helpers = createAutoRetryHelpers(deps)
	const baseEventHandler = createEventHandler(deps, helpers)
	const messageUpdateHandler = createMessageUpdateHandler(deps, helpers)
	const chatMessageHandler = createChatMessageHandler(deps, helpers)

	const cleanupInterval = setInterval(
		helpers.cleanupStaleSessions,
		5 * 60 * 1000
	)
	cleanupInterval.unref()

	logInfo(`Plugin initialized (${globalFallbackModels.length} global fallback model(s) configured)`)

	return {
		name: PLUGIN_NAME,

		config: (opencodeConfig: Record<string, unknown>) => {
			// Try 'agents' (plural) first, then 'agent' (singular)
			const agentsValue = opencodeConfig.agents
			const agentValue = opencodeConfig.agent
			
			if (agentsValue && typeof agentsValue === "object" && !Array.isArray(agentsValue)) {
				agentConfigs = agentsValue as Record<string, unknown>
			} else if (agentValue && typeof agentValue === "object" && !Array.isArray(agentValue)) {
				agentConfigs = agentValue as Record<string, unknown>
			} else {
				agentConfigs = undefined
			}
			
			logInfo(`Plugin initialized with ${agentConfigs ? Object.keys(agentConfigs).length : 0} agents`)
		},

		event: async ({
			event,
		}: {
			event: { type: string; properties?: unknown }
		}) => {
			if (event.type === "message.updated") {
				if (!deps.config.enabled) return
				const props = event.properties as
					| Record<string, unknown>
					| undefined
				await messageUpdateHandler(props)
				return
			}
			await baseEventHandler({ event })
		},

		"chat.message": async (
			input: ChatMessageInput,
			output: ChatMessageOutput
		) => {
			await chatMessageHandler(input, output)
		},
	}
}
