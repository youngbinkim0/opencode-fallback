import { describe, test, expect, mock } from "bun:test"
import { createEventHandler } from "./event-handler"
import { DEFAULT_CONFIG } from "./constants"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"

describe("createEventHandler", () => {
	describe("#when session.error arrives while pendingFallbackModel is set", () => {
		test("#then session.error is skipped before fallback processing", async () => {
			const sessionID = "ses_pending_guard"
			const state = createFallbackState("google/antigravity-claude-opus-4-6-thinking")
			state.currentModel = "anthropic/claude-opus-4-6"
			state.pendingFallbackModel = "anthropic/claude-opus-4-6"
			state.attemptCount = 1
			state.fallbackIndex = 0

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: {
							showToast: mock(async () => {}),
						},
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {
					planner: {
						model: "google/antigravity-claude-opus-4-6-thinking",
						fallback_models: [
							"anthropic/claude-opus-4-6",
							"github-copilot/gpt-5.3-codex",
						],
					},
				},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
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

			const resolveAgentForSessionFromContext = mock(async () => "planner")
			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext,
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID,
						agent: "planner",
						error: { name: "UnknownError", message: "late stale error" },
					},
				},
			})

			expect(resolveAgentForSessionFromContext).not.toHaveBeenCalled()
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
			expect(state.attemptCount).toBe(1)
			expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
			expect(state.pendingFallbackModel).toBe("anthropic/claude-opus-4-6")
		})
	})

	describe("#when session.idle fires after fallback dispatch with no first token", () => {
		test("#then it treats idle as silent model failure and triggers next fallback", async () => {
			const sessionID = "ses_silent_fail"
			const state = createFallbackState("github-copilot/claude-opus-4.6")
			// Simulate: fallback dispatched to google/gemini-pro (attempt 1),
			// but it silently failed — no first token received.
			state.currentModel = "google/gemini-pro"
			state.attemptCount = 1
			state.fallbackIndex = 0
			state.failedModels.set("github-copilot/claude-opus-4.6", Date.now())

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: {
							showToast: mock(async () => {}),
						},
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {
					test: {
						model: "github-copilot/claude-opus-4.6",
						fallback_models: [
							"google/gemini-pro",
							"anthropic/claude-3-5-haiku-latest",
						],
					},
				},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map([[sessionID, false]]),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.idle",
					properties: { sessionID },
				},
			})

			// Should have cleared awaiting state
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			// Should have called autoRetryWithFallback with the next model
			expect(autoRetryWithFallback).toHaveBeenCalledTimes(1)
			const call = autoRetryWithFallback.mock.calls[0]
			expect(call[0]).toBe(sessionID)
			expect(call[1]).toBe("anthropic/claude-3-5-haiku-latest")
			expect(call[3]).toBe("session.idle.silent-failure")
		})

		test("#then idle clears awaiting state when first token WAS received (model completed)", async () => {
			const sessionID = "ses_streaming_ok"
			const state = createFallbackState("github-copilot/claude-opus-4.6")
			state.currentModel = "google/gemini-pro"
			state.attemptCount = 1
			state.fallbackIndex = 0

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: {
							showToast: mock(async () => {}),
						},
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				// First token WAS received — model streamed and is now idle
				sessionFirstTokenReceived: new Map([[sessionID, true]]),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const clearSessionFallbackTimeout = mock(() => {})
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout,
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.idle",
					properties: { sessionID },
				},
			})

			// Should NOT trigger fallback — model completed normally
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
			// Awaiting should be CLEARED — session went idle after streaming
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			// Timeout should be cleared
			expect(clearSessionFallbackTimeout).toHaveBeenCalledWith(sessionID)
		})
	})

	describe("#when session.error arrives while sessionAwaitingFallbackResult is set", () => {
		test("#then session.error is ignored as likely stale", async () => {
			const sessionID = "ses_awaiting_error"
			const state = createFallbackState("google/antigravity")
			state.currentModel = "anthropic/claude-opus-4-6"
			state.attemptCount = 1

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map(),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID,
						error: { name: "UnknownError", message: "stale error" },
					},
				},
			})

			expect(autoRetryWithFallback).not.toHaveBeenCalled()
			expect(helpers.resolveAgentForSessionFromContext).not.toHaveBeenCalled()
		})
	})

	describe("#when session.error arrives with stale errorModel", () => {
		test("#then session.error is ignored", async () => {
			const sessionID = "ses_stale_model"
			const state = createFallbackState("google/antigravity")
			state.currentModel = "anthropic/claude-opus-4-6"
			state.attemptCount = 1
			state.failedModels.set("google/antigravity", Date.now())

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
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

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID,
						model: "google/antigravity",
						error: { name: "UnknownError", message: "stale error from old model" },
					},
				},
			})

			// Should be ignored because errorModel !== currentModel
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
		})
	})

	describe("#when session.error arrives with pendingFallbackModel after await", () => {
		test("#then session.error is ignored due to post-await recheck", async () => {
			const sessionID = "ses_post_await"
			// No state initially — will be created by message.updated concurrently
			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: { test: { model: "google/antigravity", fallback_models: ["anthropic/claude-opus-4-6"] } },
				globalFallbackModels: [],
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

			const autoRetryWithFallback = mock(async () => true)
			// Simulate: during resolveAgentForSessionFromContext, state gets created
			// with pendingFallbackModel set (by message.updated handler running concurrently)
			const resolveAgentMock = mock(async () => {
				const state = createFallbackState("google/antigravity")
				state.pendingFallbackModel = "anthropic/claude-opus-4-6"
				deps.sessionStates.set(sessionID, state)
				return "test"
			})
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: resolveAgentMock,
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID,
						error: { statusCode: 429, message: "rate limited" },
					},
				},
			})

			// Should not retry — pendingFallbackModel was set during agent resolution
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
		})
	})

	describe("#when session.error receives MessageAbortedError from plugin-initiated abort", () => {
		test("#then it is suppressed when sessionSelfAbortTimestamp is recent", async () => {
			const sessionID = "ses_self_abort_error"
			const state = createFallbackState("anthropic/claude-opus-4-6")

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: { test: { model: "anthropic/claude-opus-4-6", fallback_models: ["openai/gpt-4o"] } },
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set(),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map(),
				// Plugin aborted this session 100ms ago
				sessionSelfAbortTimestamp: new Map([[sessionID, Date.now() - 100]]),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID,
						error: { name: "MessageAbortedError", message: "Message was aborted" },
					},
				},
			})

			// Should NOT trigger fallback — the abort was self-inflicted
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
			expect(helpers.resolveAgentForSessionFromContext).not.toHaveBeenCalled()
		})

		test("#then it is NOT suppressed when abort timestamp is old (>2s)", async () => {
			const sessionID = "ses_old_abort_error"
			const state = createFallbackState("anthropic/claude-opus-4-6")

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: { test: { model: "anthropic/claude-opus-4-6", fallback_models: ["openai/gpt-4o"] } },
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set(),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map(),
				// Plugin aborted this session 3 seconds ago — outside the 2s window
				sessionSelfAbortTimestamp: new Map([[sessionID, Date.now() - 3000]]),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID,
						error: { name: "MessageAbortedError", message: "Message was aborted" },
					},
				},
			})

			// MessageAbortedError is NOT retryable and not in fallback chain,
			// so without the self-abort guard it should be skipped by the
			// retryable check — NOT dispatched.
			// The point is the self-abort guard didn't fire (timestamp too old).
			// The error will fall through to isRetryableError which returns false.
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
		})

		test("#then it is suppressed even without sessionAwaitingFallbackResult set", async () => {
			const sessionID = "ses_no_awaiting_abort"
			const state = createFallbackState("anthropic/claude-opus-4-6")

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: { test: { model: "anthropic/claude-opus-4-6", fallback_models: ["openai/gpt-4o"] } },
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				// NOT in sessionAwaitingFallbackResult — simulates the micro-window
				sessionAwaitingFallbackResult: new Set(),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map(),
				sessionSelfAbortTimestamp: new Map([[sessionID, Date.now() - 50]]),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID,
						error: { name: "MessageAbortedError", message: "Message was aborted" },
					},
				},
			})

			// Should be suppressed by self-abort guard, NOT by awaiting guard
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
			expect(helpers.resolveAgentForSessionFromContext).not.toHaveBeenCalled()
		})
	})

	describe("#when session.idle resolves idle waiters before checking awaiting state", () => {
		test("#then waiters are resolved even when sessionAwaitingFallbackResult is set", async () => {
			const sessionID = "ses_idle_waiters"
			let waiterResolved = false

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
				sessionStates: new Map(),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map([[sessionID, true]]),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map([[sessionID, [() => { waiterResolved = true }]]]),
				sessionLastMessageTime: new Map(),
			}

			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback: mock(async () => true),
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.idle",
					properties: { sessionID },
				},
			})

			expect(waiterResolved).toBe(true)
		})
	})

	describe("#when session.deleted fires", () => {
		test("#then all session maps and sets are cleaned up", async () => {
			const sessionID = "ses_to_delete"
			const state = createFallbackState("anthropic/claude-opus-4-6")

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map([[sessionID, Date.now()]]),
				sessionRetryInFlight: new Set([sessionID]),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map([[sessionID, true]]),
				sessionSelfAbortTimestamp: new Map([[sessionID, Date.now()]]),
				sessionParentID: new Map([[sessionID, "parent-1"]]),
				sessionIdleResolvers: new Map([[sessionID, [() => {}]]]),
				sessionLastMessageTime: new Map([[sessionID, Date.now()]]),
			}

			const clearSessionFallbackTimeout = mock(() => {})
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout,
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback: mock(async () => true),
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.deleted",
					properties: { info: { id: sessionID } },
				},
			})

			expect(deps.sessionStates.has(sessionID)).toBe(false)
			expect(deps.sessionLastAccess.has(sessionID)).toBe(false)
			expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			expect(deps.sessionFirstTokenReceived.has(sessionID)).toBe(false)
			expect(deps.sessionSelfAbortTimestamp.has(sessionID)).toBe(false)
			expect(deps.sessionParentID.has(sessionID)).toBe(false)
			expect(deps.sessionIdleResolvers.has(sessionID)).toBe(false)
			expect(deps.sessionLastMessageTime.has(sessionID)).toBe(false)
			expect(clearSessionFallbackTimeout).toHaveBeenCalledWith(sessionID)
		})
	})

	describe("#when session.stop fires with active fallback state", () => {
		test("#then it aborts, clears timeout, and cleans up retry state", async () => {
			const sessionID = "ses_stop_active"
			const state = createFallbackState("anthropic/claude-opus-4-6")
			state.pendingFallbackModel = "openai/gpt-4o"

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set([sessionID]),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map(),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const abortSessionRequest = mock(async () => {})
			const clearSessionFallbackTimeout = mock(() => {})
			const helpers = {
				abortSessionRequest,
				clearSessionFallbackTimeout,
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback: mock(async () => true),
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.stop",
					properties: { sessionID },
				},
			})

			// Should abort because retryInFlight or awaitingFallbackResult was set
			expect(abortSessionRequest).toHaveBeenCalledWith(sessionID, "session.stop")
			expect(clearSessionFallbackTimeout).toHaveBeenCalledWith(sessionID)
			expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			expect(state.pendingFallbackModel).toBeUndefined()
		})
	})

	describe("#when config.enabled is false", () => {
		test("#then all events are ignored", async () => {
			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG, enabled: false },
				agentConfigs: {},
				globalFallbackModels: [],
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

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			// Fire a session.error — should be completely ignored
			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						sessionID: "ses_disabled",
						error: { statusCode: 429, message: "rate limited" },
					},
				},
			})

			expect(autoRetryWithFallback).not.toHaveBeenCalled()
			expect(helpers.resolveAgentForSessionFromContext).not.toHaveBeenCalled()
		})
	})

	describe("#when session.status fires with non-retry status type", () => {
		test("#then it is ignored", async () => {
			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
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

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.status",
					properties: {
						sessionID: "ses_status",
						status: { type: "progress", message: "Working..." },
					},
				},
			})

			expect(autoRetryWithFallback).not.toHaveBeenCalled()
		})
	})

	describe("#when session.error fires without sessionID", () => {
		test("#then it is silently ignored", async () => {
			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
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

			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback: mock(async () => true),
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			// Should not throw
			await handleEvent({
				event: {
					type: "session.error",
					properties: {
						error: { statusCode: 500, message: "server error" },
					},
				},
			})

			expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
		})
	})

	describe("#when session.idle fires with retry already in flight (silent failure path)", () => {
		test("#then it skips the silent failure retry", async () => {
			const sessionID = "ses_idle_lock"
			const state = createFallbackState("anthropic/claude-opus-4-6")

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: { test: { model: "anthropic/claude-opus-4-6", fallback_models: ["openai/gpt-4o"] } },
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				// Lock already held by another handler
				sessionRetryInFlight: new Set([sessionID]),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map([[sessionID, false]]),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: { type: "session.idle", properties: { sessionID } },
			})

			// Should skip because retry lock is already held
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
		})
	})

	describe("#when session.status fires while sessionAwaitingFallbackResult is set", () => {
		test("#then it advances the fallback chain to the next model (quota exceeded on current)", async () => {
			const sessionID = "ses_status_advance"
			const state = createFallbackState("anthropic/claude-opus-4-6")
			state.currentModel = "github-copilot/grok-code-fast-1"
			state.attemptCount = 1
			state.fallbackIndex = 0
			state.failedModels.set("anthropic/claude-opus-4-6", Date.now())

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {
					fast: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: [
							"github-copilot/grok-code-fast-1",
							"openai/gpt-4o",
						],
					},
				},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				// Fallback already dispatched — awaiting result
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map(),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "fast"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.status",
					properties: {
						sessionID,
						status: {
							type: "retry",
							attempt: 1,
							message: "Too Many Requests: quota exceeded",
							next: Date.now() + 999999999,
						},
					},
				},
			})

			// Should advance to next model (openai/gpt-4o), not stay on grok-code-fast-1
			expect(autoRetryWithFallback).toHaveBeenCalledTimes(1)
			const call = autoRetryWithFallback.mock.calls[0]
			expect(call[1]).toBe("openai/gpt-4o")
			// Awaiting should have been cleared
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
		})
	})

	describe("#given P1 regression: session.idle silent-failure acquires lock before clearing timeout", () => {
		test("#then retryInFlight is set before clearSessionFallbackTimeout is called", async () => {
			const sessionID = "ses_idle_race"
			const state = createFallbackState("google/gemini-pro")
			state.currentModel = "google/gemini-pro"
			state.attemptCount = 1

			const callOrder: string[] = []

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
						get: mock(async () => ({ data: {} })),
						command: mock(async () => {}),
					},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: { test: { model: "anthropic/claude-opus-4-6", fallback_models: ["google/gemini-pro", "openai/gpt-4o"] } },
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map([[sessionID, false]]),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const clearSessionFallbackTimeout = mock(() => {
				callOrder.push("clearTimeout")
				// At this point, retryInFlight should already be set
				// (this is the fix — lock acquired BEFORE clearing timeout)
				expect(deps.sessionRetryInFlight.has(sessionID)).toBe(true)
			})

			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout,
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback: mock(async () => {
					callOrder.push("autoRetry")
					return true
				}),
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: { type: "session.idle", properties: { sessionID } },
			})

			// Verify the order: lock acquired, then timeout cleared, then retry dispatched
			expect(callOrder[0]).toBe("clearTimeout")
			expect(callOrder[1]).toBe("autoRetry")
			// The key assertion: retryInFlight was set WHEN clearTimeout was called
			// (verified inside the mock above)
			expect(clearSessionFallbackTimeout).toHaveBeenCalledWith(sessionID)
		})
	})

	describe("#when session.compacted fires for a session with active fallback state", () => {
		test("#then it clears awaiting state, retry lock, timeout, and first-token bookkeeping", async () => {
			const sessionID = "ses_compacted_cleanup"
			const state = createFallbackState("anthropic/claude-opus-4-6")
			state.currentModel = "openai/gpt-4o"
			state.attemptCount = 1
			state.fallbackIndex = 0

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
							get: mock(async () => ({ data: {} })),
							command: mock(async () => {}),
						},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set([sessionID]),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map([[sessionID, true]]),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const clearSessionFallbackTimeout = mock(() => {})
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout,
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback: mock(async () => true),
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			await handleEvent({
				event: {
					type: "session.compacted",
					properties: { sessionID },
				},
			})

			// All fallback tracking state should be cleared
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionFirstTokenReceived.has(sessionID)).toBe(false)
			expect(clearSessionFallbackTimeout).toHaveBeenCalledWith(sessionID)
			// Should NOT trigger another fallback
			expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
		})
	})

	describe("#when session.compacted fires then session.idle follows", () => {
		test("#then session.idle does NOT trigger silent-failure branch", async () => {
			const sessionID = "ses_compacted_then_idle"
			const state = createFallbackState("anthropic/claude-opus-4-6")
			state.currentModel = "openai/gpt-4o"
			state.attemptCount = 1

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
							get: mock(async () => ({ data: {} })),
							command: mock(async () => {}),
						},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: { compaction: { model: "anthropic/claude-opus-4-6", fallback_models: ["openai/gpt-4o"] } },
				globalFallbackModels: [],
				sessionStates: new Map([[sessionID, state]]),
				sessionLastAccess: new Map(),
				sessionRetryInFlight: new Set(),
				sessionAwaitingFallbackResult: new Set([sessionID]),
				sessionFallbackTimeouts: new Map(),
				sessionFirstTokenReceived: new Map([[sessionID, true]]),
				sessionSelfAbortTimestamp: new Map(),
				sessionParentID: new Map(),
				sessionIdleResolvers: new Map(),
				sessionLastMessageTime: new Map(),
			}

			const autoRetryWithFallback = mock(async () => true)
			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback,
				resolveAgentForSessionFromContext: mock(async () => "compaction"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			// First: session.compacted clears awaiting state
			await handleEvent({
				event: {
					type: "session.compacted",
					properties: { sessionID },
				},
			})

			// Awaiting should be cleared now
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)

			// Second: session.idle arrives — should NOT trigger silent-failure
			await handleEvent({
				event: {
					type: "session.idle",
					properties: { sessionID },
				},
			})

			// No fallback dispatched — compaction already completed successfully
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
		})
	})

	describe("#when session.compacted fires for a session with no active fallback", () => {
		test("#then it is a no-op and does not crash", async () => {
			const sessionID = "ses_compacted_noop"

			const deps: HookDeps = {
				ctx: {
					directory: "/test",
					client: {
						session: {
							abort: mock(async () => {}),
							messages: mock(async () => ({ data: [] })),
							promptAsync: mock(async () => {}),
							get: mock(async () => ({ data: {} })),
							command: mock(async () => {}),
						},
						tui: { showToast: mock(async () => {}) },
					},
				},
				config: { ...DEFAULT_CONFIG },
				agentConfigs: {},
				globalFallbackModels: [],
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

			const helpers = {
				abortSessionRequest: mock(async () => {}),
				clearSessionFallbackTimeout: mock(() => {}),
				scheduleSessionFallbackTimeout: mock(() => {}),
				autoRetryWithFallback: mock(async () => true),
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
				getParentSessionID: mock(async () => null),
			}

			const { handleEvent } = createEventHandler(deps, helpers)

			// Should not throw — no active state for this session
			await handleEvent({
				event: {
					type: "session.compacted",
					properties: { sessionID },
				},
			})

			expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			expect(helpers.clearSessionFallbackTimeout).toHaveBeenCalledWith(sessionID)
		})
	})
})
