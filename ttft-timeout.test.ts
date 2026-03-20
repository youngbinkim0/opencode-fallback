import { describe, test, expect, mock } from "bun:test"
import { createAutoRetryHelpers } from "./auto-retry"
import { createMessageUpdateHandler } from "./message-update-handler"
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
