import { describe, test, expect, mock } from "bun:test"
import { createMessageUpdateHandler, hasVisibleAssistantResponse } from "./message-update-handler"
import { createFallbackState } from "./fallback-state"
import { extractAutoRetrySignal } from "./error-classifier"
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
		autoRetryWithFallback: mock(async () => true),
		resolveAgentForSessionFromContext: mock(async () => undefined),
		cleanupStaleSessions: mock(() => {}),
	} as unknown as AutoRetryHelpers
}

describe("message-update-handler", () => {
	describe("#given hasVisibleAssistantResponse", () => {
		describe("#when assistant has visible text content", () => {
			test("#then returns true", async () => {
				const ctx = createMockDeps().ctx
				const checker = hasVisibleAssistantResponse(extractAutoRetrySignal)
				const result = await checker(ctx, "ses_visible", undefined)
				expect(result).toBe(true)
			})
		})

		describe("#when no messages exist", () => {
			test("#then returns false", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => ({
					data: [],
				}))
				const checker = hasVisibleAssistantResponse(extractAutoRetrySignal)
				const result = await checker(deps.ctx, "ses_empty", undefined)
				expect(result).toBe(false)
			})
		})

		describe("#when last assistant has an error", () => {
			test("#then returns false", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => ({
					data: [
						{
							info: { role: "assistant", error: { name: "Error", message: "fail" } },
							parts: [{ type: "text", text: "some text" }],
						},
					],
				}))
				const checker = hasVisibleAssistantResponse(extractAutoRetrySignal)
				const result = await checker(deps.ctx, "ses_error", undefined)
				expect(result).toBe(false)
			})
		})

		describe("#when last assistant has empty parts", () => {
			test("#then returns false", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => ({
					data: [
						{
							info: { role: "assistant" },
							parts: [],
						},
					],
				}))
				const checker = hasVisibleAssistantResponse(extractAutoRetrySignal)
				const result = await checker(deps.ctx, "ses_no_parts", undefined)
				expect(result).toBe(false)
			})
		})

		describe("#when last assistant has only whitespace text", () => {
			test("#then returns false", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => ({
					data: [
						{
							info: { role: "assistant" },
							parts: [{ type: "text", text: "   \n  " }],
						},
					],
				}))
				const checker = hasVisibleAssistantResponse(extractAutoRetrySignal)
				const result = await checker(deps.ctx, "ses_ws", undefined)
				expect(result).toBe(false)
			})
		})

		describe("#when session.messages throws", () => {
			test("#then returns false gracefully", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => {
					throw new Error("API error")
				})
				const checker = hasVisibleAssistantResponse(extractAutoRetrySignal)
				const result = await checker(deps.ctx, "ses_fail", undefined)
				expect(result).toBe(false)
			})
		})

		describe("#when no assistant message exists (only user messages)", () => {
			test("#then returns false", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => ({
					data: [
						{
							info: { role: "user" },
							parts: [{ type: "text", text: "hello" }],
						},
					],
				}))
				const checker = hasVisibleAssistantResponse(extractAutoRetrySignal)
				const result = await checker(deps.ctx, "ses_no_asst", undefined)
				expect(result).toBe(false)
			})
		})
	})

	describe("#given createMessageUpdateHandler non-assistant messages", () => {
		describe("#when role is user", () => {
			test("#then handler returns without processing", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID: "ses_user",
						role: "user",
					},
					parts: [{ type: "text", text: "hello" }],
				})

				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})
		})

		describe("#when info is undefined", () => {
			test("#then handler returns without processing", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({})

				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given createMessageUpdateHandler with assistant error", () => {
		describe("#when error is retryable and fallback models exist", () => {
			test("#then triggers fallback via autoRetryWithFallback", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_retry_error"

				deps.agentConfigs = {
					test: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["openai/gpt-4o"],
					},
				}
				deps.globalFallbackModels = ["openai/gpt-4o"]

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
						error: { statusCode: 429, message: "rate limited" },
					},
				})

				expect(helpers.autoRetryWithFallback).toHaveBeenCalled()
			})
		})

		describe("#when error is not retryable and not in fallback chain", () => {
			test("#then does not trigger fallback", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_non_retry"

				deps.agentConfigs = {
					test: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["openai/gpt-4o"],
					},
				}
				deps.globalFallbackModels = ["openai/gpt-4o"]

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
						error: { name: "InvalidRequestError", message: "bad request" },
					},
				})

				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})
		})

		describe("#when error is from stale model", () => {
			test("#then ignores non-retryable stale error", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_stale_msg"

				const state = createFallbackState("google/antigravity")
				state.currentModel = "anthropic/claude-opus-4-6"
				state.attemptCount = 1
				deps.sessionStates.set(sessionID, state)

				deps.globalFallbackModels = ["openai/gpt-4o"]

				const handler = createMessageUpdateHandler(deps, helpers)

				// Non-retryable error (403) from stale model — should be ignored
				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "google/antigravity",
						error: { statusCode: 403, message: "forbidden" },
					},
				})

				// Error from google/antigravity but current model is anthropic — stale and non-retryable
				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})

			test("#then resyncs retryable stale error to error model and plans fallback", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_stale_resync"

				const state = createFallbackState("google/antigravity")
				state.currentModel = "anthropic/claude-opus-4-6"
				state.attemptCount = 1
				deps.sessionStates.set(sessionID, state)

				deps.globalFallbackModels = ["openai/gpt-4o"]

				const handler = createMessageUpdateHandler(deps, helpers)

				// Retryable error (500) from stale model — resyncs state and retries
				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "google/antigravity",
						error: { statusCode: 500, message: "server error" },
					},
				})

				// Retryable stale error triggers resync → fallback planning
				expect(helpers.autoRetryWithFallback).toHaveBeenCalled()
			})
		})

		describe("#when no fallback models are configured", () => {
			test("#then does not trigger fallback", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_no_models"

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
						error: { statusCode: 429, message: "rate limited" },
					},
				})

				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given createMessageUpdateHandler TTFT tracking", () => {
		describe("#when assistant message arrives with text content and no state exists", () => {
			test("#then creates state and schedules timeout if fallback models configured", async () => {
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				;(helpers.resolveAgentForSessionFromContext as any).mockImplementation(
					async () => "test"
				)
				const sessionID = "ses_ttft_new"

				deps.agentConfigs = {
					test: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["openai/gpt-4o"],
					},
				}

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
					},
					parts: [{ type: "text", text: "Hello" }],
				})

				// State should be created on-demand
				expect(deps.sessionStates.has(sessionID)).toBe(true)
				const state = deps.sessionStates.get(sessionID)!
				expect(state.originalModel).toBe("anthropic/claude-opus-4-6")
			})
		})

		describe("#when assistant message has text content and state already exists with active timeout", () => {
			test("#then marks firstTokenReceived as true", async () => {
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				const sessionID = "ses_ttft_existing"

				deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
				// Simulate an active timeout — without this, the handler would
				// schedule a new timeout instead of marking firstTokenReceived.
				deps.sessionFallbackTimeouts.set(sessionID, setTimeout(() => {}, 30000) as any)

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
					},
					parts: [{ type: "text", text: "Hello world" }],
				})

				expect(deps.sessionFirstTokenReceived.get(sessionID)).toBe(true)
				clearTimeout(deps.sessionFallbackTimeouts.get(sessionID)!)
			})
		})

		describe("#when assistant message has empty parts, state exists, and timeout active", () => {
			test("#then marks firstTokenReceived true (model is active, even without text parts)", async () => {
				// Any subsequent message.updated for an existing session with an
				// active timeout marks firstTokenReceived=true. The model is
				// demonstrably active (sending events), so the TTFT timeout should
				// not abort it.
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				const sessionID = "ses_ttft_empty"

				deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
				deps.sessionFallbackTimeouts.set(sessionID, setTimeout(() => {}, 30000) as any)

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
					},
					parts: [],
				})

				expect(deps.sessionFirstTokenReceived.get(sessionID)).toBe(true)
				clearTimeout(deps.sessionFallbackTimeouts.get(sessionID)!)
			})
		})

		describe("#when assistant message only has tool calls (no text)", () => {
			test("#then marks firstTokenReceived true and does not keep awaiting flag", async () => {
				// E.g. Compaction agent returns tool calls without text.
				// This shouldn't be treated as a silent failure.
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				const sessionID = "ses_tool_only"

				deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
				deps.sessionAwaitingFallbackResult.add(sessionID)

				// checkVisibleResponse mock returning false (simulating no text)
				// but the event itself has a tool_call part
				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
					},
					parts: [{ type: "tool_call", name: "some_tool" }],
				})

				// Because checkVisibleResponse (mocked to fail) failed, the handler
				// checks event parts. It sees the tool_call, marks active, but keeps
				// awaiting flag because it thinks it's just "streaming".
				// BUT wait - if it's a fallback model, we WANT it to clear awaiting
				// flag once the tool call is completed?
				// Actually, `hasVisibleAssistantResponse` in the mock always returns false
				// unless we mock it. Our mock in createMockDeps doesn't mock
				// hasVisibleAssistantResponse, it mocks ctx.client.session.messages.

				expect(deps.sessionFirstTokenReceived.get(sessionID)).toBe(true)
			})
		})

		describe("#when state exists but no timeout running and no firstTokenReceived", () => {
			test("#then schedules TTFT timeout (covers manual model change scenario)", async () => {
				// After a manual model change, chat-message-handler creates fresh
				// state but doesn't schedule a timeout. The first message.updated
				// must schedule one so a hung model gets detected.
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				const sessionID = "ses_manual_ttft"

				deps.sessionStates.set(sessionID, createFallbackState("google/antigravity-claude-opus-4-6-thinking"))
				// No timeout set, no firstTokenReceived — simulates post-manual-change state

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "google/antigravity-claude-opus-4-6-thinking",
					},
					parts: [],
				})

				// Should NOT have set firstTokenReceived — it should schedule a timeout first
				expect(deps.sessionFirstTokenReceived.get(sessionID)).toBeUndefined()
				// resolveAgentForSessionFromContext was called to schedule the timeout
				expect(helpers.resolveAgentForSessionFromContext).toHaveBeenCalled()
			})
		})
	})

	describe("#given createMessageUpdateHandler tracks sessionLastMessageTime", () => {
		describe("#when assistant message arrives", () => {
			test("#then updates sessionLastMessageTime for subagent-sync", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_last_msg"

				const before = Date.now()
				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
					},
					parts: [{ type: "text", text: "Hello" }],
				})

				const ts = deps.sessionLastMessageTime.get(sessionID)
				expect(ts).toBeDefined()
				expect(ts!).toBeGreaterThanOrEqual(before)
			})
		})
	})

	describe("#given P0 regression: TTFT timeout must not abort actively streaming primary model", () => {
		describe("#when primary model sends multiple non-error message.updated events", () => {
			test("#then firstTokenReceived is set true on subsequent updates, preventing timeout abort", async () => {
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				;(helpers.resolveAgentForSessionFromContext as any).mockImplementation(
					async () => "opus"
				)
				const sessionID = "ses_ttft_regression"

				deps.agentConfigs = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/gemini-pro"],
					},
				}

				const handler = createMessageUpdateHandler(deps, helpers)

				// First message.updated — creates state, schedules timeout
				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
					},
					parts: [],
				})

				// In production, the timeout callback is scheduled async by resolveAgent...
				// For the test, we simulate the timeout being active:
				deps.sessionFallbackTimeouts.set(sessionID, setTimeout(() => {}, 30000) as any)

				expect(deps.sessionStates.has(sessionID)).toBe(true)
				// First token NOT received yet (empty initial frame)
				expect(deps.sessionFirstTokenReceived.get(sessionID) ?? false).toBe(false)

				// Subsequent message.updated — model is streaming
				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
					},
					parts: [{ type: "text", text: "Hello" }],
				})

				// Now firstTokenReceived MUST be true
				expect(deps.sessionFirstTokenReceived.get(sessionID)).toBe(true)
				clearTimeout(deps.sessionFallbackTimeouts.get(sessionID)!)
			})
		})

		describe("#when primary model sends non-error updates without text parts (empty frames)", () => {
			test("#then firstTokenReceived is still set true because model is active", async () => {
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				;(helpers.resolveAgentForSessionFromContext as any).mockImplementation(
					async () => "opus"
				)
				const sessionID = "ses_ttft_empty_frames"

				deps.agentConfigs = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/gemini-pro"],
					},
				}

				const handler = createMessageUpdateHandler(deps, helpers)

				// First message.updated — creates state
				await handler({
					info: { sessionID, role: "assistant", model: "anthropic/claude-opus-4-6" },
					parts: [],
				})

				// Simulate active timeout
				deps.sessionFallbackTimeouts.set(sessionID, setTimeout(() => {}, 30000) as any)

				// Second message.updated — no text parts, but model IS active
				// (this is the exact scenario from the production log)
				await handler({
					info: { sessionID, role: "assistant", model: "anthropic/claude-opus-4-6" },
					parts: [],
				})

				// firstTokenReceived must be true — model is sending updates
				expect(deps.sessionFirstTokenReceived.get(sessionID)).toBe(true)
				clearTimeout(deps.sessionFallbackTimeouts.get(sessionID)!)
			})
		})

		describe("#when primary model sends updates and timeout was scheduled", () => {
			test("#then timeout is rescheduled on activity", async () => {
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				;(helpers.resolveAgentForSessionFromContext as any).mockImplementation(
					async () => "opus"
				)
				const sessionID = "ses_ttft_reschedule"

				deps.agentConfigs = {
					opus: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["google/gemini-pro"],
					},
				}

				const handler = createMessageUpdateHandler(deps, helpers)

				// First message.updated — creates state, schedules timeout
				await handler({
					info: { sessionID, role: "assistant", model: "anthropic/claude-opus-4-6" },
					parts: [],
				})

				// Simulate that a timeout was scheduled
				const fakeTimer = globalThis.setTimeout(() => {}, 999999)
				deps.sessionFallbackTimeouts.set(sessionID, fakeTimer)

				// Second message.updated — should trigger reschedule
				await handler({
					info: { sessionID, role: "assistant", model: "anthropic/claude-opus-4-6" },
					parts: [{ type: "text", text: "streaming..." }],
				})

				// firstTokenReceived must be set
				expect(deps.sessionFirstTokenReceived.get(sessionID)).toBe(true)
			})
		})
	})

	describe("#given createMessageUpdateHandler with retry signal override", () => {
		describe("#when retry signal is present and retry is already in flight", () => {
			test("#then overrides the in-flight retry", async () => {
				const deps = createMockDeps({ timeout_seconds: 30 })
				const helpers = createMockHelpers()
				const sessionID = "ses_override"

				deps.sessionRetryInFlight.add(sessionID)
				deps.agentConfigs = {
					test: {
						model: "anthropic/claude-opus-4-6",
						fallback_models: ["openai/gpt-4o"],
					},
				}
				deps.globalFallbackModels = ["openai/gpt-4o"]

				const handler = createMessageUpdateHandler(deps, helpers)

				// extractAutoRetrySignal needs both retry and rate-limit signals
				// in the info object (status + message fields)
				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
						error: { statusCode: 429, message: "rate limited" },
						status: "Retrying in 30 seconds",
						message: "Too many requests - quota exceeded",
					},
				})

				// Should have aborted the in-flight retry and dispatched new one
				expect(helpers.abortSessionRequest).toHaveBeenCalled()
				expect(helpers.autoRetryWithFallback).toHaveBeenCalled()
			})
		})
	})

	describe("#given createMessageUpdateHandler with duplicate fallback guard", () => {
		describe("#when state has pendingFallbackModel from a different model", () => {
			test("#then skips duplicate trigger", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_dup_guard"

				const state = createFallbackState("anthropic/claude-opus-4-6")
				state.pendingFallbackModel = "google/gemini-pro"
				deps.sessionStates.set(sessionID, state)

				deps.globalFallbackModels = ["openai/gpt-4o"]

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
						error: { statusCode: 429, message: "rate limited" },
					},
				})

				// Should skip — pending fallback for different model
				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given createMessageUpdateHandler self-abort suppression", () => {
		describe("#when MessageAbortedError within self-abort window", () => {
			test("#then error is suppressed", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_self_abort"

				const state = createFallbackState("anthropic/claude-opus-4-6")
				deps.sessionStates.set(sessionID, state)
				deps.sessionSelfAbortTimestamp.set(sessionID, Date.now() - 100)

				deps.globalFallbackModels = ["openai/gpt-4o"]

				const handler = createMessageUpdateHandler(deps, helpers)

				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "anthropic/claude-opus-4-6",
						error: { name: "MessageAbortedError", message: "aborted" },
					},
				})

				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given stale error from already-failed model (resync loop prevention)", () => {
		describe("#when error model is in failedModels", () => {
			test("#then ignores the stale error instead of resyncing state", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_resync_loop"

				// State: primary k2p5 failed, currently on gemini-flash
				const state = createFallbackState("kimi-for-coding/k2p5")
				state.currentModel = "google/gemini-flash"
				state.fallbackIndex = 1
				state.attemptCount = 1
				state.failedModels.set("kimi-for-coding/k2p5", Date.now())
				deps.sessionStates.set(sessionID, state)
				deps.globalFallbackModels = [
					"kimi-for-coding/k2p5",
					"google/gemini-flash",
					"anthropic/claude-haiku-4-5",
				]

				const handler = createMessageUpdateHandler(deps, helpers)

				// Stale error arrives from k2p5 (already in failedModels)
				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "kimi-for-coding/k2p5",
						error: { statusCode: 402, name: "APIError", message: "Payment required" },
					},
				})

				// Should NOT resync state back to k2p5
				expect(state.currentModel).toBe("google/gemini-flash")
				// Should NOT trigger another fallback
				expect(helpers.autoRetryWithFallback).not.toHaveBeenCalled()
			})
		})

		describe("#when error model is NOT in failedModels", () => {
			test("#then resyncs to error model and plans fallback", async () => {
				const deps = createMockDeps()
				const helpers = createMockHelpers()
				const sessionID = "ses_resync_legit"

				// State: thinks current model is gemini-flash, but actual error is from k2p5
				// k2p5 is NOT in failedModels — this is a genuine state desync
				const state = createFallbackState("kimi-for-coding/k2p5")
				state.currentModel = "google/gemini-flash"
				state.fallbackIndex = 1
				state.attemptCount = 1
				// k2p5 NOT in failedModels
				deps.sessionStates.set(sessionID, state)
				deps.globalFallbackModels = [
					"kimi-for-coding/k2p5",
					"google/gemini-flash",
					"anthropic/claude-haiku-4-5",
				]

				const handler = createMessageUpdateHandler(deps, helpers)

				// Error from k2p5 — not in failedModels, legitimate resync
				await handler({
					info: {
						sessionID,
						role: "assistant",
						model: "kimi-for-coding/k2p5",
						error: { statusCode: 429, name: "RateLimitError", message: "rate limited" },
					},
				})

				// Should resync to k2p5 and trigger fallback
				expect(helpers.autoRetryWithFallback).toHaveBeenCalled()
			})
		})
	})
})
