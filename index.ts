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
import {
	isEmptyTaskResult,
	isCancelledTaskResult,
	extractChildSessionID,
	waitForChildFallbackResult,
} from "./subagent-result-sync"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { logInfo } from "./logger"

declare function setInterval(
	callback: () => void,
	delay: number
): { unref: () => void } & ReturnType<typeof globalThis.setInterval>

function loadPluginConfig(directory: string): Partial<FallbackPluginConfig> {
	const configPaths = [
		join(directory, ".opencode", "opencode-fallback.jsonc"),
		join(directory, ".opencode", "opencode-fallback.json"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.jsonc"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.json"),
	]

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8")
				// parseJsonc handles // comments, /* */ blocks, and trailing commas seamlessly
				return parseJsonc(content) as Partial<FallbackPluginConfig>
			} catch (err) {
				logInfo(`[${PLUGIN_NAME}] Failed to parse config: ${configPath}`, err as Record<string, unknown>)
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
	const globalFallbackModels = normalizeFallbackModelsField(
		configOverrides?.fallback_models ?? fileConfig.fallback_models
	)

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
		sessionCompactionInFlight: new Set(),
		sessionProviderRetrying: new Set(),
	}

	const helpers = createAutoRetryHelpers(deps)
	const { handleEvent: baseEventHandler, handleActivity } = createEventHandler(deps, helpers)
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
			
			if (hasConcreteAssistantActivity(event.type, event.properties)) {
				const props = event.properties as Record<string, unknown> | undefined
				const info = props?.info as Record<string, unknown> | undefined
				const sessionID =
					(props?.sessionID as string | undefined) ??
					(info?.sessionID as string | undefined) ??
					(info?.id as string | undefined)
				// Extract model from activity event so handleActivity can
				// distinguish stale activity from the failed model vs real
				// activity from the fallback model.
				const activityModel =
					(info?.model as string | undefined) ??
					(typeof info?.providerID === "string" && typeof info?.modelID === "string"
						? `${info.providerID}/${info.modelID}`
						: undefined) ??
					(props?.model as string | undefined)
				if (sessionID) {
					await handleActivity(sessionID, activityModel)
				}
			}
			
			await baseEventHandler({ event })

		},

		"tool.execute.after": async (
			input: { tool: string; sessionID: string; callID: string; args: any },
			output: { title: string; output: string; metadata: any }
		) => {
			// OpenCode can report a child that failed during fallback as either an
			// empty task result or a cancelled task-tool error.
			const isEmptyResult = isEmptyTaskResult(output.output)
			const isCancelledResult = isCancelledTaskResult(output.output, output.metadata)
			if (input.tool !== "task" || (!isEmptyResult && !isCancelledResult)) {
				return
			}

			const childSessionID =
				extractChildSessionID(output.output) ??
				extractChildSessionID(serializeMetadata(output.metadata))
			if (!childSessionID) {
				logInfo("Task result needs fallback sync but no child session ID found", {
					sessionID: input.sessionID,
					outputPreview: output.output?.substring(0, 200),
				})
				return
			}

			// A task can also be cancelled by OpenCode when the model exhausts its
			// reasoning/output limit. Do not wait for a fallback that was never
			// dispatched; ordinary task cancellation should return immediately.
			const bridgeStartedAt = helpers.claimChildFallbackBridge(childSessionID, input.sessionID)
			if (
				isCancelledResult &&
				bridgeStartedAt === undefined &&
				!deps.sessionAwaitingFallbackResult.has(childSessionID) &&
				!deps.sessionRetryInFlight.has(childSessionID) &&
				!deps.sessionStates.get(childSessionID)?.pendingFallbackModel
			) {
				logInfo("Ignoring cancelled task without active fallback", {
					parentSession: input.sessionID,
					childSession: childSessionID,
				})
				return
			}

			if (isEmptyResult && !deps.sessionRetryInFlight.has(childSessionID)) {
				logInfo("Empty task result has no active fallback; dispatching child fallback", {
					parentSession: input.sessionID,
					childSession: childSessionID,
				})
				const taskAgent =
					typeof input.args?.subagent_type === "string" ? input.args.subagent_type : undefined
				await helpers.retryEmptyChildTask(childSessionID, taskAgent)
			}
			logInfo("Detected task result requiring fallback sync, waiting for child fallback", {
				parentSession: input.sessionID,
				childSession: childSessionID,
			})

			// Wait for child session fallback to complete (bounded)
			const maxWaitMs = Math.min(
				(deps.config.timeout_seconds || 120) * 1000,
				120_000,
			)
			try {
				const replacementText = await waitForChildFallbackResult(deps, childSessionID, {
					maxWaitMs,
					pollIntervalMs: 500,
					notBeforeMs: bridgeStartedAt,
				})

				if (replacementText) {
					output.output = replacementText
					logInfo("Replaced task result with fallback response", {
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
			} finally {
				helpers.clearChildFallbackBridge(childSessionID)
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

export function hasConcreteAssistantActivity(type: string, properties: unknown): boolean {
	const props = properties as Record<string, unknown> | undefined
	if (type === "message.part.delta") {
		const field = props?.field
		return (field === "text" || field === "reasoning") &&
			typeof props?.delta === "string" && props.delta.length > 0
	}
	if (type !== "message.part.updated") return false

	const part = props?.part as Record<string, unknown> | undefined
	if (!part) return false
	if (part.type === "tool") return true
	return (part.type === "text" || part.type === "reasoning") &&
		typeof part.text === "string" && part.text.length > 0
}

function serializeMetadata(metadata: unknown): string {
	if (typeof metadata === "string") return metadata
	try {
		return JSON.stringify(metadata) ?? ""
	} catch {
		return ""
	}
}
