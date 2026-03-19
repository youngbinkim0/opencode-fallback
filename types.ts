export interface FallbackPluginConfig {
	enabled?: boolean
	retry_on_errors?: number[]
	max_fallback_attempts?: number
	cooldown_seconds?: number
	timeout_seconds?: number
	notify_on_fallback?: boolean
	fallback_models?: string | string[]
}

export interface FallbackState {
	originalModel: string
	currentModel: string
	fallbackIndex: number
	failedModels: Map<string, number>
	attemptCount: number
	pendingFallbackModel?: string
}

export interface FallbackResult {
	success: boolean
	newModel?: string
	error?: string
	maxAttemptsReached?: boolean
}

export type MessagePart = { type: string } & Record<string, unknown>

export type ReplayTier = 1 | 2 | 3

export interface ReplayResult {
	success: boolean
	tier?: ReplayTier
	sentParts?: MessagePart[]
	droppedTypes?: string[]
	error?: string
}

export interface ChatMessageInput {
	sessionID: string
	agent?: string
	model?: {
		providerID: string
		modelID: string
	}
}

export interface ChatMessageOutput {
	message: {
		model?: {
			providerID: string
			modelID: string
		}
	}
	parts?: Array<{
		type: string
		text?: string
	}>
}

export interface FallbackPluginHook {
	event: (input: {
		event: { type: string; properties?: unknown }
	}) => Promise<void>
	"chat.message"?: (
		input: ChatMessageInput,
		output: ChatMessageOutput
	) => Promise<void>
}

export interface PluginContext {
	directory: string
	client: {
		session: {
			abort: (args: { path: { id: string } }) => Promise<void>
			messages: (args: {
				path: { id: string }
				query: { directory: string }
			}) => Promise<{
				data?: Array<{
					info?: Record<string, unknown>
					parts?: Array<{ type?: string; text?: string }>
				}>
			}>
			promptAsync: (args: {
				path: { id: string }
				body: {
					agent?: string
					model: { providerID: string; modelID: string }
					parts: MessagePart[]
				}
				query: { directory: string }
			}) => Promise<void>
			get: (args: {
				path: { id: string }
			}) => Promise<{ data?: Record<string, unknown> }>
		}
		tui: {
			showToast: (args: {
				body: {
					title: string
					message: string
					variant: string
					duration: number
				}
			}) => Promise<void>
		}
	}
}

export interface HookDeps {
	ctx: PluginContext
	config: Required<FallbackPluginConfig>
	agentConfigs: Record<string, unknown> | undefined
	sessionStates: Map<string, FallbackState>
	sessionLastAccess: Map<string, number>
	sessionRetryInFlight: Set<string>
	sessionAwaitingFallbackResult: Set<string>
	sessionFallbackTimeouts: Map<string, ReturnType<typeof setTimeout>>
}
