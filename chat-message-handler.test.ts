import { describe, test, expect, mock } from "bun:test"
import { createChatMessageHandler } from "./chat-message-handler"
import { createFallbackState } from "./fallback-state"
import type { HookDeps, FallbackPluginConfig, ChatMessageInput, ChatMessageOutput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { DEFAULT_CONFIG } from "./constants"

function createMockDeps(configOverrides?: Partial<FallbackPluginConfig>): HookDeps {
	return {
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
		resolveAgentForSessionFromContext: mock(() => undefined),
		cleanupStaleSessions: mock(() => {}),
	} as unknown as AutoRetryHelpers
}

function createFallbackedState(originalModel: string, fallbackModel: string, cooldownExpired: boolean) {
	const state = createFallbackState(originalModel)
	state.currentModel = fallbackModel
	state.fallbackIndex = 0
	state.attemptCount = 1
	state.failedModels.set(originalModel, cooldownExpired ? Date.now() - 120_000 : Date.now())
	return state
}

describe("chat-message-handler", () => {
	describe("#given recoverToOriginal wired into chat.message hook", () => {
		describe("#when currentModel differs from originalModel and primary cooldown has expired", () => {
			test("#then recovery triggers and model override is skipped", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", true)
				deps.sessionStates.set("test-session", state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "test-session" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// Recovery should have reset currentModel to originalModel
				expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
				expect(state.fallbackIndex).toBe(-1)
				expect(state.attemptCount).toBe(0)
				// Model override should NOT have been applied (handler returns early)
				expect(output.message.model!.providerID).toBe("anthropic")
				expect(output.message.model!.modelID).toBe("claude-opus-4-6")
			})
		})

		describe("#when originalModel is still in cooldown", () => {
			test("#then recovery does not trigger and fallback model override applies", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set("test-session", state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "test-session" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// Should still be on fallback model
				expect(state.currentModel).toBe("google/gemini-pro")
				// Model override should have applied the fallback
				expect(output.message.model!.providerID).toBe("google")
				expect(output.message.model!.modelID).toBe("gemini-pro")
			})
		})

		describe("#when sessionRetryInFlight has sessionID", () => {
			test("#then recovery does not trigger even if cooldown expired", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", true)
				deps.sessionStates.set("test-session", state)
				deps.sessionRetryInFlight.add("test-session")

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "test-session" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// Should still be on fallback model
				expect(state.currentModel).toBe("google/gemini-pro")
				// Model override should apply the fallback
				expect(output.message.model!.providerID).toBe("google")
				expect(output.message.model!.modelID).toBe("gemini-pro")
			})
		})

		describe("#when sessionAwaitingFallbackResult has sessionID", () => {
			test("#then recovery does not trigger even if cooldown expired", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", true)
				deps.sessionStates.set("test-session", state)
				deps.sessionAwaitingFallbackResult.add("test-session")

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "test-session" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// Should still be on fallback model
				expect(state.currentModel).toBe("google/gemini-pro")
				// Model override should apply the fallback
				expect(output.message.model!.providerID).toBe("google")
				expect(output.message.model!.modelID).toBe("gemini-pro")
			})
		})

		describe("#when recovery occurs and notify_on_fallback is true", () => {
			test("#then recovery toast is shown with info variant", async () => {
				const deps = createMockDeps({ notify_on_fallback: true })
				const helpers = createMockHelpers()
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", true)
				deps.sessionStates.set("test-session", state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "test-session" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				expect(deps.ctx.client.tui.showToast).toHaveBeenCalledTimes(1)
				const toastArgs = (deps.ctx.client.tui.showToast as any).mock.calls[0][0]
				expect(toastArgs.body.title).toBe("Model Recovered")
				expect(toastArgs.body.message).toContain("claude-opus-4-6")
				expect(toastArgs.body.variant).toBe("info")
				expect(toastArgs.body.duration).toBe(3000)
			})
		})

		describe("#when recovery occurs and notify_on_fallback is false", () => {
			test("#then no recovery toast is shown", async () => {
				const deps = createMockDeps({ notify_on_fallback: false })
				const helpers = createMockHelpers()
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", true)
				deps.sessionStates.set("test-session", state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "test-session" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// Recovery still happened
				expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
				// But no toast
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
			})
		})

		describe("#when currentModel already equals originalModel", () => {
			test("#then no recovery attempt is made and handler returns early", async () => {
				const deps = createMockDeps({ notify_on_fallback: true })
				const helpers = createMockHelpers()
				const state = createFallbackState("anthropic/claude-opus-4-6")
				deps.sessionStates.set("test-session", state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "test-session" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// Still on primary
				expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
				// No toast — no recovery needed
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
				// Model should not have been overridden
				expect(output.message.model!.providerID).toBe("anthropic")
				expect(output.message.model!.modelID).toBe("claude-opus-4-6")
			})
		})
	})
})
