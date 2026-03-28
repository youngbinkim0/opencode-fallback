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
					command: mock(async () => {}),
					revert: mock(async () => {}),
					summarize: mock(async () => ({ data: true })),
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
		sessionCompactionInFlight: new Set(),
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

	describe("#given user manually selects the current fallback model", () => {
		describe("#when requestedModel equals currentModel but differs from originalModel", () => {
			test("#then originalModel is updated to adopt fallback as new primary (no future recovery)", async () => {
				const deps = createMockDeps({ notify_on_fallback: true })
				const helpers = createMockHelpers()
				// State: original=opus, current=gemini (fallback), cooldown NOT expired
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set("test-session", state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = {
					sessionID: "test-session",
					model: {
						providerID: "google",
						modelID: "gemini-pro",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "google", modelID: "gemini-pro" },
					},
				}

				await handler(input, output)

				// originalModel should now be adopted to gemini-pro
				expect(state.originalModel).toBe("google/gemini-pro")
				expect(state.currentModel).toBe("google/gemini-pro")
				// failedModels should be cleared so cooldown doesn't interfere
				expect(state.failedModels.size).toBe(0)
				expect(state.attemptCount).toBe(0)
				// No recovery toast should have been shown
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
			})
		})

		describe("#when cooldown later expires after adoption", () => {
			test("#then recovery does NOT trigger (originalModel === currentModel)", async () => {
				const deps = createMockDeps({ notify_on_fallback: true })
				const helpers = createMockHelpers()
				// State: original=opus, current=gemini (fallback), cooldown expired
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", true)
				deps.sessionStates.set("test-session", state)

				const handler = createChatMessageHandler(deps, helpers)

				// Step 1: User manually selects gemini-pro (adopts it)
				await handler(
					{
						sessionID: "test-session",
						model: { providerID: "google", modelID: "gemini-pro" },
					},
					{ message: { model: { providerID: "google", modelID: "gemini-pro" } } }
				)

				expect(state.originalModel).toBe("google/gemini-pro")

				// Step 2: Next chat.message — recovery check should NOT fire
				await handler(
					{ sessionID: "test-session" },
					{ message: { model: { providerID: "google", modelID: "gemini-pro" } } }
				)

				// No recovery toast — originalModel === currentModel
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
				// Still on gemini-pro
				expect(state.currentModel).toBe("google/gemini-pro")
			})
		})
	})

	describe("#given adoption guard during active fallback (race condition fix)", () => {
		describe("#when requestedModel equals currentModel and sessionAwaitingFallbackResult is set", () => {
			test("#then adoption is SKIPPED (replay's chat.message, not user action)", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_race_adoption"

				// State: fallback committed — currentModel is now the fallback model
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set(sessionID, state)
				// Plugin dispatched a replay and is awaiting the result
				deps.sessionAwaitingFallbackResult.add(sessionID)

				const handler = createChatMessageHandler(deps, helpers)
				// promptAsync triggers chat.message with the fallback model
				const input: ChatMessageInput = {
					sessionID,
					model: {
						providerID: "google",
						modelID: "gemini-pro",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "google", modelID: "gemini-pro" },
					},
				}

				await handler(input, output)

				// originalModel should NOT have changed — adoption must be skipped
				expect(state.originalModel).toBe("anthropic/claude-opus-4-6")
				// failedModels should NOT have been cleared
				expect(state.failedModels.size).toBe(1)
				// attemptCount should NOT have been reset
				expect(state.attemptCount).toBe(1)
				// fallbackIndex should NOT have been reset
				expect(state.fallbackIndex).toBe(0)
			})
		})

		describe("#when requestedModel equals currentModel and sessionRetryInFlight is set", () => {
			test("#then adoption is SKIPPED", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_race_retry"

				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set(sessionID, state)
				deps.sessionRetryInFlight.add(sessionID)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = {
					sessionID,
					model: {
						providerID: "google",
						modelID: "gemini-pro",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "google", modelID: "gemini-pro" },
					},
				}

				await handler(input, output)

				// originalModel should NOT have changed
				expect(state.originalModel).toBe("anthropic/claude-opus-4-6")
				expect(state.failedModels.size).toBe(1)
				expect(state.attemptCount).toBe(1)
			})
		})

		describe("#when requestedModel equals currentModel and no fallback flags are set", () => {
			test("#then adoption proceeds normally (genuine user action)", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_genuine_adopt"

				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set(sessionID, state)
				// No retry in flight, no awaiting result — this is a real user action

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = {
					sessionID,
					model: {
						providerID: "google",
						modelID: "gemini-pro",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "google", modelID: "gemini-pro" },
					},
				}

				await handler(input, output)

				// Adoption should proceed
				expect(state.originalModel).toBe("google/gemini-pro")
				expect(state.failedModels.size).toBe(0)
				expect(state.attemptCount).toBe(0)
			})
		})
	})

	describe("#given config.enabled is false", () => {
		describe("#when any chat.message arrives", () => {
			test("#then handler returns immediately without processing", async () => {
				const deps = createMockDeps({ enabled: false })
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

				// State should not be modified
				expect(state.currentModel).toBe("google/gemini-pro")
				// Model should not be overridden
				expect(output.message.model!.providerID).toBe("anthropic")
			})
		})
	})

	describe("#given no state exists for session", () => {
		describe("#when chat.message arrives for unknown session", () => {
			test("#then handler returns immediately", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID: "ses_unknown" }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// No state created, model not modified
				expect(deps.sessionStates.has("ses_unknown")).toBe(false)
				expect(output.message.model!.providerID).toBe("anthropic")
			})
		})
	})

	describe("#given manual model change detection", () => {
		describe("#when requested model differs from state and no fallback is in flight", () => {
			test("#then state is reset to new model", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_manual"

				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set(sessionID, state)
				// No retry in flight — this is a genuine manual model change

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = {
					sessionID,
					model: {
						providerID: "openai",
						modelID: "gpt-4o",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "openai", modelID: "gpt-4o" },
					},
				}

				await handler(input, output)

				// State should be reset to the new manual model
				const newState = deps.sessionStates.get(sessionID)!
				expect(newState.originalModel).toBe("openai/gpt-4o")
				expect(newState.currentModel).toBe("openai/gpt-4o")
				expect(newState.attemptCount).toBe(0)
			})
		})

		describe("#when requested model differs from state but retry IS in flight", () => {
			test("#then model mismatch is ignored (not treated as manual change)", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_manual_during_retry"

				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set(sessionID, state)
				deps.sessionRetryInFlight.add(sessionID)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = {
					sessionID,
					model: {
						providerID: "openai",
						modelID: "gpt-4o",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "openai", modelID: "gpt-4o" },
					},
				}

				await handler(input, output)

				// State should NOT be reset — the plugin is managing the fallback
				expect(state.currentModel).toBe("google/gemini-pro")
				expect(state.originalModel).toBe("anthropic/claude-opus-4-6")
				// No abort should have been called
				expect(helpers.abortSessionRequest).not.toHaveBeenCalled()
				// Retry lock should still be held by the original caller
				expect(deps.sessionRetryInFlight.has(sessionID)).toBe(true)
			})
		})

		describe("#when requested model differs from state but awaiting fallback result", () => {
			test("#then model mismatch is ignored (not treated as manual change)", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_manual_during_await"

				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/gemini-pro", false)
				deps.sessionStates.set(sessionID, state)
				deps.sessionAwaitingFallbackResult.add(sessionID)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = {
					sessionID,
					model: {
						providerID: "openai",
						modelID: "gpt-4o",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "openai", modelID: "gpt-4o" },
					},
				}

				await handler(input, output)

				// State should NOT be reset — the plugin is managing the fallback
				expect(state.currentModel).toBe("google/gemini-pro")
				expect(state.originalModel).toBe("anthropic/claude-opus-4-6")
				// No abort should have been called
				expect(helpers.abortSessionRequest).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given pending fallback model matching requested model", () => {
		describe("#when requestedModel equals pendingFallbackModel", () => {
			test("#then clears pending and returns without resetting state", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_pending_match"

				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.currentModel = "anthropic/claude-opus-4-6"
				state.pendingFallbackModel = "google/gemini-pro"
				deps.sessionStates.set(sessionID, state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = {
					sessionID,
					model: {
						providerID: "google",
						modelID: "gemini-pro",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "google", modelID: "gemini-pro" },
					},
				}

				await handler(input, output)

				// pendingFallbackModel should be cleared
				expect(state.pendingFallbackModel).toBeUndefined()
				// State should NOT be reset (still original model)
				expect(state.originalModel).toBe("anthropic/claude-opus-4-6")
				// No abort should have been called
				expect(helpers.abortSessionRequest).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given model override with nested provider path", () => {
		describe("#when fallback model has multiple slashes", () => {
			test("#then providerID is first segment, modelID is the rest", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_nested"

				// Use createFallbackedState to properly set up cooldown so recovery doesn't fire
				const state = createFallbackedState("anthropic/claude-opus-4-6", "google/models/gemini-2.0-pro", false)
				deps.sessionStates.set(sessionID, state)

				const handler = createChatMessageHandler(deps, helpers)
				const input: ChatMessageInput = { sessionID }
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
					},
				}

				await handler(input, output)

				// Should override with the fallback model's nested path
				expect(output.message.model!.providerID).toBe("google")
				expect(output.message.model!.modelID).toBe("models/gemini-2.0-pro")
			})
		})
	})

	describe("#given chat.message during active retry with model mismatch", () => {
		describe("#when the requested model is in the fallback chain", () => {
			test("#then it does NOT mutate state.currentModel", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_no_mutate"

				const state = createFallbackState("google/antigravity-gemini-3-flash")
				deps.sessionStates.set(sessionID, state)
				// Simulate active retry in flight
				deps.sessionRetryInFlight.add(sessionID)
				deps.agentConfigs = {
					sonnet: {
						model: "google/antigravity-gemini-3-flash",
						fallback_models: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o"],
					},
				}

				const handler = createChatMessageHandler(deps, helpers)

				const input: ChatMessageInput = {
					sessionID,
					agent: "sonnet",
					model: {
						providerID: "anthropic",
						modelID: "claude-sonnet-4-6",
					},
				}
				const output: ChatMessageOutput = {
					message: {
						model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
					},
				}

				await handler(input, output)

				// currentModel should NOT have been changed — commitFallback owns that
				expect(state.currentModel).toBe("google/antigravity-gemini-3-flash")
			})
		})
	})
})
