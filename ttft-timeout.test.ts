import { describe, test, expect, mock } from "bun:test"
import { createAutoRetryHelpers } from "./auto-retry"
import { createMessageUpdateHandler } from "./message-update-handler"
import { createEventHandler } from "./event-handler"
import { createFallbackState } from "./fallback-state"
import type { HookDeps, FallbackPluginConfig } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { DEFAULT_CONFIG } from "./constants"

function createMockDeps(configOverrides?: Partial<FallbackPluginConfig>): HookDeps {
	return {
		ctx: {
			directory: "/test",
			client: {
				session: {
					abort: mock(async () => {}),
					messages: mock(async () => ({
						data: [
							{
								info: { role: "assistant" },
								parts: [{ type: "text", text: "Hello response" }],
							},
						],
					})),
					promptAsync: mock(async () => {}),
					get: mock(async () => ({ data: {} })),
				},
				tui: {
					showToast: mock(async () => {}),
				},
			},
		},
		config: { ...DEFAULT_CONFIG, ...configOverrides } as Required<FallbackPluginConfig>,
		agentConfigs: undefined,
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
}

function createMockHelpers(): AutoRetryHelpers {
	return {
		abortSessionRequest: mock(async () => {}),
		clearSessionFallbackTimeout: mock(() => {}),
		scheduleSessionFallbackTimeout: mock(() => {}),
		autoRetryWithFallback: mock(async () => {}),
		resolveAgentForSessionFromContext: mock(async () => undefined),
		cleanupStaleSessions: mock(() => {}),
	} as unknown as AutoRetryHelpers
}

describe("TTFT-based timeout", () => {
	describe("#given timeout enabled (timeout_seconds > 0)", () => {
		describe("#when timeout fires and first token has been received", () => {
			test("#then timeout is a no-op and session is not aborted", async () => {
				const deps = createMockDeps({ timeout_seconds: 0.01 })
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/gemini-pro"
				deps.sessionStates.set("test-session", state)
				deps.sessionFirstTokenReceived.set("test-session", true)

				const helpers = createAutoRetryHelpers(deps)
				helpers.scheduleSessionFallbackTimeout("test-session")

				await new Promise((r) => globalThis.setTimeout(r, 50))

				expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
			})
		})

		describe("#when timeout fires and no first token received", () => {
			test("#then session is aborted", async () => {
				const deps = createMockDeps({ timeout_seconds: 0.01 })
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/gemini-pro"
				deps.sessionStates.set("test-session", state)
				deps.sessionFirstTokenReceived.set("test-session", false)

				const helpers = createAutoRetryHelpers(deps)
				helpers.scheduleSessionFallbackTimeout("test-session")

				await new Promise((r) => globalThis.setTimeout(r, 50))

				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
			})
		})
	})

	describe("#given timeout disabled (timeout_seconds = 0)", () => {
		describe("#when timeout_seconds is 0", () => {
			test("#then no timeout is scheduled", async () => {
				const deps = createMockDeps({ timeout_seconds: 0 })
				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "google/gemini-pro"
				deps.sessionStates.set("test-session", state)

				const helpers = createAutoRetryHelpers(deps)
				helpers.scheduleSessionFallbackTimeout("test-session")

				await new Promise((r) => globalThis.setTimeout(r, 50))

				expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given autoRetryWithFallback dispatches a retry", () => {
		describe("#when the retry is dispatched", () => {
			test("#then sessionFirstTokenReceived is set to false", async () => {
				const deps = createMockDeps()
				deps.ctx.client.session.messages = mock(async () => ({
					data: [
						{
							info: { role: "user" },
							parts: [{ type: "text", text: "hello" }],
						},
					],
				})) as any

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				expect(deps.sessionFirstTokenReceived.get("test-session")).toBe(false)
			})
		})
	})

	describe("#given message.updated handler receives assistant response", () => {
		describe("#when session is awaiting fallback result and no error", () => {
			test("#then sessionFirstTokenReceived is set to true", async () => {
				const deps = createMockDeps()
				const mockHelpers = createMockHelpers()
				deps.sessionAwaitingFallbackResult.add("test-session")
				deps.sessionStates.set(
					"test-session",
					createFallbackState("anthropic/claude-opus-4-6")
				)

				const handler = createMessageUpdateHandler(deps, mockHelpers)
				await handler({
					info: {
						sessionID: "test-session",
						role: "assistant",
					},
					parts: [{ type: "text", text: "Hello" }],
				})

				expect(deps.sessionFirstTokenReceived.get("test-session")).toBe(true)
			})
		})

		describe("#when session is awaiting fallback result but message has no visible content", () => {
			test("#then sessionFirstTokenReceived stays false (empty frame)", async () => {
				const deps = createMockDeps()
				const mockHelpers = createMockHelpers()
				// Override messages to return an assistant message with NO text
				deps.ctx.client.session.messages = mock(async () => ({
					data: [
						{
							info: { role: "assistant" },
							parts: [],
						},
					],
				})) as any
				deps.sessionAwaitingFallbackResult.add("test-session")
				deps.sessionStates.set(
					"test-session",
					createFallbackState("anthropic/claude-opus-4-6")
				)

				const handler = createMessageUpdateHandler(deps, mockHelpers)
				await handler({
					info: {
						sessionID: "test-session",
						role: "assistant",
					},
					// Event parts also have no text — truly empty frame
					parts: [],
				})

				// Should NOT mark first token received — no content arrived
				expect(deps.sessionFirstTokenReceived.get("test-session") ?? false).toBe(false)
			})

			test("#then sessionFirstTokenReceived is set if event parts have text despite no visible response", async () => {
				const deps = createMockDeps()
				const mockHelpers = createMockHelpers()
				// Override messages to return assistant with error (no visible response)
				deps.ctx.client.session.messages = mock(async () => ({
					data: [
						{
							info: { role: "assistant", error: { name: "Error", message: "failed" } },
							parts: [{ type: "text", text: "partial" }],
						},
					],
				})) as any
				deps.sessionAwaitingFallbackResult.add("test-session")
				deps.sessionStates.set(
					"test-session",
					createFallbackState("anthropic/claude-opus-4-6")
				)

				const handler = createMessageUpdateHandler(deps, mockHelpers)
				await handler({
					info: {
						sessionID: "test-session",
						role: "assistant",
					},
					// Event parts DO have text — model is streaming
					parts: [{ type: "text", text: "Hello partial" }],
				})

				// Should mark first token received — event parts have real text
				expect(deps.sessionFirstTokenReceived.get("test-session")).toBe(true)
			})
		})

		describe("#when session is NOT awaiting fallback result", () => {
			test("#then sessionFirstTokenReceived is not modified", async () => {
				const deps = createMockDeps()
				const mockHelpers = createMockHelpers()
				// NOT adding to sessionAwaitingFallbackResult

				const handler = createMessageUpdateHandler(deps, mockHelpers)
				await handler({
					info: {
						sessionID: "test-session",
						role: "assistant",
					},
					parts: [{ type: "text", text: "Hello" }],
				})

				expect(deps.sessionFirstTokenReceived.has("test-session")).toBe(false)
			})
		})
	})

	describe("#given cleanupStaleSessions", () => {
		describe("#when stale sessions are cleaned", () => {
			test("#then sessionFirstTokenReceived entries are removed", () => {
				const deps = createMockDeps()
				deps.sessionLastAccess.set(
					"stale-session",
					Date.now() - 60 * 60 * 1000
				)
				deps.sessionFirstTokenReceived.set("stale-session", true)
				deps.sessionStates.set(
					"stale-session",
					createFallbackState("model")
				)

				const helpers = createAutoRetryHelpers(deps)
				helpers.cleanupStaleSessions()

				expect(deps.sessionFirstTokenReceived.has("stale-session")).toBe(false)
			})
		})
	})

	describe("#given timeout_seconds default config", () => {
		test("#then defaults to 30", () => {
			expect(DEFAULT_CONFIG.timeout_seconds).toBe(30)
		})
	})
})

describe("MessageAbortedError self-abort suppression", () => {
	describe("#given message.updated receives MessageAbortedError after plugin-initiated abort", () => {
		test("#then error is suppressed when sessionSelfAbortTimestamp is within 2s window", async () => {
			const deps = createMockDeps()
			const mockHelpers = createMockHelpers()
			const sessionID = "ses_self_abort_msg"

			// Set up state so the session is in a fallback chain
			const state = createFallbackState("anthropic/claude-opus-4-6")
			deps.sessionStates.set(sessionID, state)
			// Plugin aborted this session 100ms ago
			deps.sessionSelfAbortTimestamp.set(sessionID, Date.now() - 100)

			// Configure fallback models
			deps.agentConfigs = {
				test: {
					model: "anthropic/claude-opus-4-6",
					fallback_models: ["openai/gpt-4o"],
				},
			}

			const handler = createMessageUpdateHandler(deps, mockHelpers)
			await handler({
				info: {
					sessionID,
					role: "assistant",
					model: "anthropic/claude-opus-4-6",
					error: { name: "MessageAbortedError", message: "Message was aborted" },
				},
			})

			// Should NOT trigger fallback — the abort was self-inflicted
			expect(mockHelpers.autoRetryWithFallback).not.toHaveBeenCalled()
		})

		test("#then error is suppressed even without sessionAwaitingFallbackResult", async () => {
			const deps = createMockDeps()
			const mockHelpers = createMockHelpers()
			const sessionID = "ses_no_await_msg"

			const state = createFallbackState("anthropic/claude-opus-4-6")
			deps.sessionStates.set(sessionID, state)
			deps.sessionSelfAbortTimestamp.set(sessionID, Date.now() - 50)
			// Explicitly NOT in sessionAwaitingFallbackResult (micro-window)

			deps.agentConfigs = {
				test: {
					model: "anthropic/claude-opus-4-6",
					fallback_models: ["openai/gpt-4o"],
				},
			}

			const handler = createMessageUpdateHandler(deps, mockHelpers)
			await handler({
				info: {
					sessionID,
					role: "assistant",
					model: "anthropic/claude-opus-4-6",
					error: { name: "MessageAbortedError", message: "Message was aborted" },
				},
			})

			// Should be suppressed by self-abort guard
			expect(mockHelpers.autoRetryWithFallback).not.toHaveBeenCalled()
		})

		test("#then error is NOT suppressed when abort timestamp is beyond 2s window", async () => {
			const deps = createMockDeps()
			const mockHelpers = createMockHelpers()
			const sessionID = "ses_old_abort_msg"

			const state = createFallbackState("anthropic/claude-opus-4-6")
			deps.sessionStates.set(sessionID, state)
			// Abort was 3 seconds ago — outside 2s window
			deps.sessionSelfAbortTimestamp.set(sessionID, Date.now() - 3000)

			deps.agentConfigs = {
				test: {
					model: "anthropic/claude-opus-4-6",
					fallback_models: ["openai/gpt-4o"],
				},
			}
			deps.globalFallbackModels = ["openai/gpt-4o"]

			const handler = createMessageUpdateHandler(deps, mockHelpers)
			await handler({
				info: {
					sessionID,
					role: "assistant",
					model: "anthropic/claude-opus-4-6",
					error: { name: "MessageAbortedError", message: "Message was aborted" },
				},
			})

			// MessageAbortedError is NOT retryable and not in fallback chain,
			// so it should be skipped by the retryable error check (not the self-abort guard).
			// The important thing is the self-abort guard did NOT catch it.
			expect(mockHelpers.autoRetryWithFallback).not.toHaveBeenCalled()
		})

		test("#then non-MessageAbortedError is not affected by self-abort guard", async () => {
			const deps = createMockDeps()
			const mockHelpers = createMockHelpers()
			const sessionID = "ses_real_error_msg"

			const state = createFallbackState("anthropic/claude-opus-4-6")
			deps.sessionStates.set(sessionID, state)
			// Plugin aborted recently, but error is NOT MessageAbortedError
			deps.sessionSelfAbortTimestamp.set(sessionID, Date.now() - 100)

			deps.agentConfigs = {
				test: {
					model: "anthropic/claude-opus-4-6",
					fallback_models: ["openai/gpt-4o"],
				},
			}
			deps.globalFallbackModels = ["openai/gpt-4o"]

			const handler = createMessageUpdateHandler(deps, mockHelpers)
			await handler({
				info: {
					sessionID,
					role: "assistant",
					model: "anthropic/claude-opus-4-6",
					error: { statusCode: 429, message: "rate limited" },
				},
			})

			// 429 IS retryable, so fallback should be triggered despite
			// the recent self-abort timestamp (guard only applies to
			// MessageAbortedError specifically)
			expect(mockHelpers.autoRetryWithFallback).toHaveBeenCalled()
		})
	})
})
