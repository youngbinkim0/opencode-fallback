export interface FallbackPluginConfig {
	enabled?: boolean
	retry_on_errors?: number[]
	/** Additional regex patterns (strings) that mark an error as retryable.
	 *  These supplement the built-in patterns. Each string is compiled as
	 *  a case-insensitive regex and matched against the error message. */
	retryable_error_patterns?: string[]
	max_fallback_attempts?: number
	cooldown_seconds?: number
	/** Time-to-first-token timeout in seconds.  If the fallback model does not
	 *  produce its first token within this window, it is aborted and the next
	 *  fallback is tried.  Once streaming begins the timeout is cancelled.
	 *  Set to 0 to disable. */
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

/** Returned by planFallback — describes what to do but does NOT mutate state. */
export interface FallbackPlan {
	success: true
	newModel: string
	failedModel: string
	newFallbackIndex: number
}

export interface FallbackPlanFailure {
	success: false
	error: string
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
	globalFallbackModels: string[]
	sessionStates: Map<string, FallbackState>
	sessionLastAccess: Map<string, number>
	sessionRetryInFlight: Set<string>
	sessionAwaitingFallbackResult: Set<string>
	sessionFallbackTimeouts: Map<string, ReturnType<typeof setTimeout>>
	sessionFirstTokenReceived: Map<string, boolean>
	/** Timestamp of the last plugin-initiated abort per session.
	 *  Used to distinguish self-inflicted MessageAbortedError from user cancellation. */
	sessionSelfAbortTimestamp: Map<string, number>
	/** Cached parentID for child sessions.  `undefined` value means "looked up,
	 *  no parent" so we distinguish from "never looked up" (key absent). */
	sessionParentID: Map<string, string | null>
	/** Resolvers for code awaiting a session to go idle (e.g. subagent-sync
	 *  waiting for a child session's fallback response to complete). */
	sessionIdleResolvers: Map<string, Array<() => void>>
	/** Timestamp of the last message.updated event per session.
	 *  Used by subagent-sync to detect child activity and reset timeouts. */
	sessionLastMessageTime: Map<string, number>
}
