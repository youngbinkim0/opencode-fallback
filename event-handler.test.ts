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
			}

			const handler = createEventHandler(deps, helpers)

			await handler({
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
			}

			const handler = createEventHandler(deps, helpers)

			await handler({
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

		test("#then idle is suppressed (normal) when first token WAS received", async () => {
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
				// First token WAS received — model is streaming fine
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
				resolveAgentForSessionFromContext: mock(async () => "test"),
				cleanupStaleSessions: mock(() => {}),
			}

			const handler = createEventHandler(deps, helpers)

			await handler({
				event: {
					type: "session.idle",
					properties: { sessionID },
				},
			})

			// Should NOT trigger fallback — model was streaming fine
			expect(autoRetryWithFallback).not.toHaveBeenCalled()
			// Awaiting should still be set (normal suppression)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
		})
	})
})
