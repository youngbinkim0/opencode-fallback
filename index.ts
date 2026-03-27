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
import { isEmptyTaskResult, extractChildSessionID, waitForChildFallbackResult } from "./subagent-result-sync"
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
				// Strip JSONC comments and trailing commas safely
				const jsonContent = content
					// Remove block comments /* ... */
					.replace(/\/\*[\s\S]*?\*\//g, "")
					// Remove single line comments // ... but avoid removing // inside strings (like http://)
					.replace(/(".*?(?<!\\)"|'.*?(?<!\\)')|\/\/.*$/gm, (match, stringLiteral) => 
						stringLiteral ? stringLiteral : ""
					)
					// Remove trailing commas
					.replace(/,(\s*[\]}])/g, "$1")
					
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
		mergedConfig ??= {
			enabled:
				configOverrides?.enabled ??
				fileConfig?.enabled ??
				DEFAULT_CONFIG.enabled,
			retry_on_errors:
				configOverrides?.retry_on_errors ??
				fileConfig?.retry_on_errors ??
				DEFAULT_CONFIG.retry_on_errors,
			retryable_error_patterns:
				configOverrides?.retryable_error_patterns ??
				fileConfig?.retryable_error_patterns ??
				DEFAULT_CONFIG.retryable_error_patterns,
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
			fallback_models:
				configOverrides?.fallback_models ??
				fileConfig?.fallback_models ??
				DEFAULT_CONFIG.fallback_models,
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
		sessionFirstTokenReceived: new Map(),
		sessionSelfAbortTimestamp: new Map(),
		sessionParentID: new Map(),
		sessionIdleResolvers: new Map(),
		sessionLastMessageTime: new Map(),
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

		"tool.execute.after": async (
			input: { tool: string; sessionID: string; callID: string; args: any },
			output: { title: string; output: string; metadata: any }
		) => {
			// Only intercept task tool calls with empty results
			if (input.tool !== "task" || !isEmptyTaskResult(output.output)) {
				return
			}

			const childSessionID = extractChildSessionID(output.output)
			if (!childSessionID) {
				logInfo("Empty task result but no child session ID found", {
					sessionID: input.sessionID,
					outputPreview: output.output?.substring(0, 200),
				})
				return
			}

			logInfo("Detected empty task result, waiting for child fallback", {
				parentSession: input.sessionID,
				childSession: childSessionID,
			})

			// Wait for child session fallback to complete (bounded)
			const maxWaitMs = Math.min(
				(deps.config.timeout_seconds || 120) * 1000,
				120_000,
			)
			const replacementText = await waitForChildFallbackResult(deps, childSessionID, {
				maxWaitMs,
				pollIntervalMs: 500,
			})

			if (replacementText) {
				output.output = replacementText
				logInfo("Replaced empty task result with fallback response", {
					parentSession: input.sessionID,
					childSession: childSessionID,
					responseLength: replacementText.length,
				})
			} else {
				logInfo("No fallback response available, preserving original output", {
					parentSession: input.sessionID,
					childSession: childSessionID,
				})
			}
		},

		"chat.message": async (
			input: ChatMessageInput,
			output: ChatMessageOutput
		) => {
			await chatMessageHandler(input, output)
		},
	}
}
