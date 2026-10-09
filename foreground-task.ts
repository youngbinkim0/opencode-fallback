import { tool, type ToolContext } from "@opencode-ai/plugin"
import type { HookDeps } from "./types"
import { getFallbackModelsForSession } from "./config-reader"
import { createFallbackState, planFallback, commitFallback } from "./fallback-state"
import { getErrorMessage, isRetryableError, isProviderWideRateLimitError } from "./error-classifier"
import { logInfo } from "./logger"

type Signal = { type: "retry"; error: unknown } | { type: "cancel" }
type Owner = { signal: (signal: Signal) => void; activity: () => void }
type Permission = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
type Session = { id: string; parentID?: string; permission?: Permission[] }
type Options = { query: { directory: string }; throwOnError: true }
// Modern SDK fields are not present in the minimum peer version's declarations.
type TaskClient = {
	app: { agents(options: Options): Promise<{ data?: Array<{ name: string; mode: string; model?: { providerID: string; modelID: string }; permission: Permission[] }> }> }
	session: {
		get(options: Options & { path: { id: string } }): Promise<{ data?: Session }>
		create(options: Options & { body: { parentID: string; title: string; permission: Permission[] } }): Promise<{ data?: Session }>
		messages(options: Options & { path: { id: string } }): Promise<{ data?: Array<{ info: { id: string; role: string; providerID: string; modelID: string } }> }>
		prompt(options: Options & { path: { id: string }; body: { agent: string; model: { providerID: string; modelID: string }; parts: Array<{ type: "text"; text: string }> } }): Promise<{ data?: { info: { error?: unknown }; parts: Array<{ type: string; text?: string }> } }>
		abort(options: Options & { path: { id: string } }): Promise<unknown>
	}
}

/** Owns the task promise, rather than trying to repair a native task after it
 * has thrown. Aborting a child prompt cannot settle this promise; only this
 * execution loop can return a result to the parent. */
export function createForegroundTask(deps: HookDeps) {
	const owners = new Map<string, Owner>()
	const client = deps.ctx.client as unknown as TaskClient
	const query = { directory: deps.ctx.directory }

	const definition = tool({
		description: "Launch a foreground subagent and wait for its result, transparently switching to configured fallback models on retryable failures. Background execution is not supported by this task replacement.",
		args: {
			description: tool.schema.string().describe("A short (3-5 words) description of the task"),
			prompt: tool.schema.string().describe("The task for the agent to perform"),
			subagent_type: tool.schema.string().describe("The type of specialized agent to use"),
			task_id: tool.schema.string().optional().describe("Existing child session to resume"),
			command: tool.schema.string().optional(),
			background: tool.schema.boolean().optional(),
		},
		async execute(args, context: ToolContext) {
			if (args.background) throw new Error("foreground_task_fallback supports foreground tasks only")
			context.abort.throwIfAborted()
			await context.ask({
				permission: "task", patterns: [args.subagent_type], always: ["*"],
				metadata: { description: args.description, subagent_type: args.subagent_type },
			})
			const agents = await client.app.agents({ query, throwOnError: true })
			const agent = agents.data?.find((item) => item.name === args.subagent_type)
			if (!agent || agent.mode === "primary") throw new Error(`Unknown subagent: ${args.subagent_type}`)
			if (!Array.isArray(agent.permission)) throw new Error("foreground_task_fallback requires a modern OpenCode permission ruleset")
			const parent = (await client.session.get({ path: { id: context.sessionID }, query, throwOnError: true })).data!
			// Match the host's default nesting limit; explicitly configured depths
			// are supplied by the config hook.
			let ancestor = parent
			let depth = 0
			while (ancestor.parentID) {
				depth++
				ancestor = (await client.session.get({ path: { id: ancestor.parentID }, query, throwOnError: true })).data!
			}
			if (depth >= maxDepth) throw new Error(`Subagent depth limit reached (${maxDepth})`)
			const messages = (await client.session.messages({ path: { id: context.sessionID }, query, throwOnError: true })).data ?? []
			const parentMessage = messages.find((message) => message.info.id === context.messageID)?.info
			const inheritedModel = parentMessage?.role === "assistant"
				? { providerID: parentMessage.providerID, modelID: parentMessage.modelID }
				: undefined
			const initial = agent.model ?? inheritedModel
			if (!initial) throw new Error("Cannot resolve subagent model")
			const permission = [
				...(parent.permission ?? []).filter((rule) => rule.action === "deny" || rule.permission === "external_directory"),
				...(["task", "todowrite"].filter((name) => !agent.permission.some((rule) => rule.permission === name))
					.map((name) => ({ permission: name, pattern: "*", action: "deny" as const }))),
				...primaryTools.map((name) => ({ permission: name, pattern: "*", action: "deny" as const })),
			]
			const child = args.task_id
				? (await client.session.get({ path: { id: args.task_id }, query, throwOnError: true })).data!
				: (await client.session.create({ query, body: { parentID: context.sessionID, title: `${args.description} (@${agent.name} subagent)`, permission }, throwOnError: true })).data!
			if (child.parentID !== context.sessionID) throw new Error("Cannot resume a task belonging to another parent")
			if (owners.has(child.id)) throw new Error("Task is already running")
			context.abort.throwIfAborted()
			const state = createFallbackState(`${initial.providerID}/${initial.modelID}`)
			const models = getFallbackModelsForSession(child.id, agent.name, deps.agentConfigs, deps.globalFallbackModels)
			logInfo("Foreground task fallback candidates captured", {
				childSession: child.id, parentSession: context.sessionID,
				agent: agent.name, currentModel: state.currentModel, fallbackModels: models,
			})
			const blockedProviders = new Set<string>()
			let lastError: unknown
			try {
				while (true) {
					context.abort.throwIfAborted()
					const [providerID, ...modelParts] = state.currentModel.split("/")
					const model = { providerID, modelID: modelParts.join("/") }
					context.metadata({ title: args.description, metadata: { sessionId: child.id, model } })
					let wake!: (signal: Signal) => void
					const signal = new Promise<Signal>((resolve) => { wake = resolve })
					let timer: ReturnType<typeof setTimeout> | undefined
					const activity = () => { clearTimeout(timer); timer = undefined }
					owners.set(child.id, {
						activity,
						signal(value) {
							if (value.type === "cancel" || nextPlan(value.error).success) wake(value)
							else activity() // No candidate: keep the provider's retry attached.
						},
					})
					const onAbort = () => wake({ type: "cancel" })
					context.abort.addEventListener("abort", onAbort, { once: true })
					if (context.abort.aborted) onAbort()
					if (deps.config.timeout_seconds > 0) {
						timer = setTimeout(() => wake({ type: "retry", error: new Error("Subagent time-to-first-token timeout") }), deps.config.timeout_seconds * 1000)
					}
					// Convert rejection into a value immediately: a retry signal may
					// win the race while the original HTTP request is still pending.
					const request = client.session.prompt({
						path: { id: child.id }, query, throwOnError: true,
						body: { agent: agent.name, model, parts: [{ type: "text", text: args.prompt }] },
					}).then((result) => ({ type: "result" as const, result }), (error: unknown) => ({ type: "error" as const, error }))
					try {
						const outcome = await Promise.race([request, signal])
						if (outcome.type === "retry" || outcome.type === "cancel") {
							// This is our SDK prompt, not OpenCode's background job. The
							// outer task stays pending while the child abort settles.
							await client.session.abort({ path: { id: child.id }, query, throwOnError: true })
							await request
							context.abort.throwIfAborted()
							if (outcome.type === "cancel") throw new Error("Task cancelled")
							lastError = outcome.error
						} else if (outcome.type === "error") {
							lastError = outcome.error
							if (!isRetryableError(lastError, deps.config.retry_on_errors, deps.config.retryable_error_patterns)) throw lastError
						} else {
							context.abort.throwIfAborted()
							const result = outcome.result.data
							if (!result) throw new Error("Subagent prompt returned no result")
							lastError = result.info.error
							if (!lastError) {
								const text = result.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
								if (!text.trim()) throw new Error("Subagent returned no text result")
								return `task_id: ${child.id}\n\n<task_result>\n${text}\n</task_result>`
							}
							if (!isRetryableError(lastError, deps.config.retry_on_errors, deps.config.retryable_error_patterns)) throw new Error(JSON.stringify(lastError))
						}
					} finally {
						activity()
						context.abort.removeEventListener("abort", onAbort)
					}
					const plan = nextPlan(lastError)
					if (!plan.success) throw new Error(`Subagent failed (task_id: ${child.id}): ${plan.error}; ${JSON.stringify(lastError)}`)
					commitFallback(state, plan)
					logInfo("Foreground task switching model while retaining parent promise", { childSession: child.id, model: state.currentModel })
					if (deps.config.notify_on_fallback) {
						await deps.ctx.client.tui.showToast({ body: { title: "Subagent Fallback", message: `${plan.failedModel} → ${plan.newModel}`, variant: "warning", duration: 5000 } }).catch(() => {})
					}
				}
			} finally {
				owners.delete(child.id)
			}

			function nextPlan(error: unknown) {
				const providerWide = isProviderWideRateLimitError(error)
				if (providerWide) blockedProviders.add(state.currentModel.split("/")[0])
				logInfo("Foreground task rate-limit scope and candidate filtering", {
					childSession: child.id, agent: args.subagent_type, currentModel: state.currentModel,
					errorMessage: getErrorMessage(error), providerWide,
					blockedProviders: [...blockedProviders], fallbackModels: models,
				})
				// Keep chain indices stable when several providers are blocked.
				return planFallback(child.id, state, models.map((model) => blockedProviders.has(model.split("/")[0]) ? state.currentModel : model), deps.config)
			}
		},
	})
	let maxDepth = 1
	let primaryTools: string[] = []
	return {
		tool: definition,
		owns: (id: string) => owners.has(id),
		configure(config: Record<string, unknown>) {
			if (typeof config.subagent_depth === "number") maxDepth = config.subagent_depth
			const experimental = config.experimental as { primary_tools?: string[] } | undefined
			primaryTools = experimental?.primary_tools ?? []
		},
		handleEvent(event: { type: string; properties?: unknown }): boolean {
			const props = event.properties as Record<string, any> | undefined
			const id = props?.sessionID ?? props?.info?.sessionID ?? props?.part?.sessionID ?? (event.type.startsWith("session.") ? props?.info?.id : undefined)
			const owner = owners.get(id)
			if (!owner) return false
			if (event.type === "session.status" && props?.status?.type === "retry") owner.signal({ type: "retry", error: { message: props.status.message } })
			if (event.type === "session.stop" || event.type === "session.deleted") owner.signal({ type: "cancel" })
			if (event.type === "message.part.delta" && props?.delta?.length) owner.activity()
			if (event.type === "message.part.updated" && (props?.part?.type === "tool" || props?.part?.text?.length)) owner.activity()
			return true
		},
	}
}
