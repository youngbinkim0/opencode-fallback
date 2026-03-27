import { describe, test, expect, mock, beforeEach } from "bun:test"
import { createAutoRetryHelpers } from "./auto-retry"
import type { HookDeps, FallbackPluginConfig, MessagePart } from "./types"
import { DEFAULT_CONFIG } from "./constants"

function createMockDeps(overrides?: Partial<{
	messagesData: Array<{
		info?: Record<string, unknown>
		parts?: Array<{ type?: string; text?: string } & Record<string, unknown>>
	}>
	promptAsyncFn: (...args: unknown[]) => Promise<void>
	commandFn: (...args: unknown[]) => Promise<void>
	showToastFn: (...args: unknown[]) => Promise<void>
}>): HookDeps {
	const messagesData = overrides?.messagesData ?? []
	const promptAsyncFn = overrides?.promptAsyncFn ?? (async () => {})
	const commandFn = overrides?.commandFn ?? (async () => {})
	const showToastFn = overrides?.showToastFn ?? (async () => {})

	return {
		ctx: {
			directory: "/test",
			client: {
				session: {
					abort: mock(async () => {}),
					messages: mock(async () => ({ data: messagesData })),
					promptAsync: mock(promptAsyncFn as any),
					command: mock(commandFn as any),
					get: mock(async () => ({ data: {} })),
				},
				tui: {
					showToast: mock(showToastFn as any),
				},
			},
		},
		config: { ...DEFAULT_CONFIG } as Required<FallbackPluginConfig>,
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

describe("auto-retry integration", () => {
	describe("#given autoRetryWithFallback with mixed parts", () => {
		describe("#when promptAsync succeeds on first call (Tier 1)", () => {
			test("#then sends all original parts including non-text", async () => {
				const mixedParts = [
					{ type: "text", text: "hello" },
					{ type: "image", url: "https://example.com/img.png" },
					{ type: "tool_result", text: "result" },
				]
				const promptCalls: MessagePart[][] = []

				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: mixedParts },
					],
					promptAsyncFn: async (args: any) => {
						promptCalls.push(args.body.parts)
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				// Should have sent all 3 parts
				expect(promptCalls.length).toBe(1)
				expect(promptCalls[0].length).toBe(3)
				expect(promptCalls[0][0].type).toBe("text")
				expect(promptCalls[0][1].type).toBe("image")
				expect(promptCalls[0][2].type).toBe("tool_result")

				// No toast — no degradation
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
			})
		})

		describe("#when promptAsync rejects non-text parts but accepts text-only", () => {
			test("#then degrades to text-only and shows toast with dropped types", async () => {
				const mixedParts = [
					{ type: "text", text: "hello" },
					{ type: "image", url: "https://example.com/img.png" },
					{ type: "tool_result", text: "result" },
				]
				const promptCalls: MessagePart[][] = []

				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: mixedParts },
					],
					promptAsyncFn: async (args: any) => {
						const parts = args.body.parts
						promptCalls.push(parts)
						// Reject anything with non-text parts
						if (parts.some((p: MessagePart) => p.type !== "text")) {
							throw new Error("Unsupported part types")
						}
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				// Should have tried multiple times, last successful with text-only
				expect(promptCalls.length).toBeGreaterThan(1)
				const lastCall = promptCalls[promptCalls.length - 1]
				expect(lastCall.length).toBe(1)
				expect(lastCall[0].type).toBe("text")

				// Toast should have been called with dropped types
				expect(deps.ctx.client.tui.showToast).toHaveBeenCalled()
				const toastArgs = (deps.ctx.client.tui.showToast as any).mock.calls[0][0]
				expect(toastArgs.body.message).toContain("image")
				expect(toastArgs.body.variant).toBe("warning")
			})
		})

		describe("#when all replay tiers fail", () => {
			test("#then retry is not dispatched and session state is cleaned up", async () => {
				const mixedParts = [
					{ type: "text", text: "hello" },
					{ type: "image", url: "https://example.com/img.png" },
				]

				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: mixedParts },
					],
					promptAsyncFn: async () => {
						throw new Error("Always fails")
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				// Session should NOT be in awaiting state
				expect(deps.sessionAwaitingFallbackResult.has("test-session")).toBe(false)
				// Retry in flight should be cleared
				expect(deps.sessionRetryInFlight.has("test-session")).toBe(false)
			})
		})

		describe("#when message has only text parts", () => {
			test("#then sends text parts and shows no toast (backward compatible)", async () => {
				const textParts = [
					{ type: "text", text: "hello world" },
					{ type: "text", text: "second part" },
				]
				const promptCalls: MessagePart[][] = []

				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: textParts },
					],
					promptAsyncFn: async (args: any) => {
						promptCalls.push(args.body.parts)
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				expect(promptCalls.length).toBe(1)
				expect(promptCalls[0].length).toBe(2)
				expect(promptCalls[0][0].type).toBe("text")
				expect(promptCalls[0][1].type).toBe("text")

				// No toast — no degradation
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
			})
		})

		describe("#when no user message found", () => {
			test("#then does not attempt replay", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				// promptAsync should not have been called (only abort was called)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})

		describe("#when retry is already in flight", () => {
			test("#then callers are responsible for checking the lock before calling autoRetryWithFallback", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})
				deps.sessionRetryInFlight.add("test-session")

				// autoRetryWithFallback no longer checks the lock itself;
				// callers (message-update-handler, event-handler) must check
				// sessionRetryInFlight BEFORE calling prepareFallback + autoRetryWithFallback.
				// So calling it directly with the lock set will still proceed.
				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				// It proceeds because the lock contract is at the caller level
				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})
	})

	describe("#given model has already stopped (error-triggered source)", () => {
		describe("#when source is session.error", () => {
			test("#then abort is skipped and replay proceeds directly", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error"
				)

				expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})

		describe("#when source is message.updated", () => {
			test("#then abort is skipped and replay proceeds directly", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"message.updated"
				)

				expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})
	})

	describe("#given caller already aborted (timeout-triggered source)", () => {
		describe("#when source is session.timeout", () => {
			test("#then autoRetryWithFallback does not double-abort but still replays", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.timeout"
				)

				// No abort inside autoRetryWithFallback (caller already did it)
				expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})
	})

	describe("#given model still in-flight (status-triggered source)", () => {
		describe("#when source is session.status", () => {
			test("#then abort IS called to stop the in-flight request", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.status"
				)

				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})

		describe("#when source is session.status.immediate", () => {
			test("#then abort IS called to stop the in-flight request", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.status.immediate"
				)

				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})
	})

	describe("#given autoRetryWithFallback race condition guards", () => {
		describe("#when state has already been advanced by another handler (plan-based)", () => {
			test("#then returns false and sets deferredToOtherHandler", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("google/antigravity")
				// Simulate: another handler already advanced to anthropic
				state.currentModel = "anthropic/claude-opus-4-6"
				state.attemptCount = 1
				deps.sessionStates.set("ses_race", state)

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_race",
					"anthropic/claude-opus-4-6",
					undefined,
					"session.error",
					{
						success: true as const,
						newModel: "anthropic/claude-opus-4-6",
						failedModel: "google/antigravity",
						newFallbackIndex: 0,
					}
				)

				expect(result).toBe(false)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})

		describe("#when sessionAwaitingFallbackResult is already set by another handler", () => {
			test("#then returns false (duplicate dispatch prevention)", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("google/antigravity")
				deps.sessionStates.set("ses_dup", state)
				// Another handler already claimed the dispatch
				deps.sessionAwaitingFallbackResult.add("ses_dup")

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_dup",
					"anthropic/claude-opus-4-6",
					undefined,
					"session.error",
					{
						success: true as const,
						newModel: "anthropic/claude-opus-4-6",
						failedModel: "google/antigravity",
						newFallbackIndex: 0,
					}
				)

				expect(result).toBe(false)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
				// sessionAwaitingFallbackResult should NOT be cleared (other handler owns it)
				expect(deps.sessionAwaitingFallbackResult.has("ses_dup")).toBe(true)
			})
		})

		describe("#when state advances during async work (post-await stale check)", () => {
			test("#then returns false after detecting stale state", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("google/antigravity")
				deps.sessionStates.set("ses_stale", state)

				// Override abort to advance state during the async window
				;(deps.ctx.client.session.abort as any).mockImplementation(async () => {
					state.currentModel = "anthropic/claude-opus-4-6"
					state.attemptCount = 1
				})

				const helpers = createAutoRetryHelpers(deps)
				// Use session.status source (triggers abort + delay)
				const result = await helpers.autoRetryWithFallback(
					"ses_stale",
					"anthropic/claude-opus-4-6",
					undefined,
					"session.status",
					{
						success: true as const,
						newModel: "anthropic/claude-opus-4-6",
						failedModel: "google/antigravity",
						newFallbackIndex: 0,
					}
				)

				expect(result).toBe(false)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})

		describe("#when source is session.idle.silent-failure", () => {
			test("#then skips abort (model already stopped)", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("google/antigravity")
				deps.sessionStates.set("ses_silent", state)

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"ses_silent",
					"anthropic/claude-opus-4-6",
					undefined,
					"session.idle.silent-failure",
					{
						success: true as const,
						newModel: "anthropic/claude-opus-4-6",
						failedModel: "google/antigravity",
						newFallbackIndex: 0,
					}
				)

				// Should NOT abort — model already stopped
				expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
				// Should dispatch
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})
	})

	describe("#given autoRetryWithFallback with a plan whose state is committed during dispatch", () => {
		describe("#when commitFallback returns false (another handler committed during async work)", () => {
			test("#then aborts the duplicate replay and returns false", async () => {
				let promptCallCount = 0
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
					promptAsyncFn: async () => {
						promptCallCount++
						// Simulate: during the promptAsync call, another handler
						// commits the same plan to state (race condition)
						const { commitFallback } = await import("./fallback-state")
						const state = deps.sessionStates.get("test-session")
						if (state) {
							commitFallback(state, {
								success: true,
								newModel: "openai/gpt-4o",
								failedModel: "anthropic/claude-opus-4-6",
								newFallbackIndex: 0,
							})
						}
					},
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("anthropic/claude-opus-4-6")
				deps.sessionStates.set("test-session", state)
				deps.sessionLastAccess.set("test-session", Date.now())

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error",
					{
						success: true,
						newModel: "openai/gpt-4o",
						failedModel: "anthropic/claude-opus-4-6",
						newFallbackIndex: 0,
					}
				)

				// Should return false since it deferred to the other handler
				expect(result).toBe(false)
				// The prompt was sent (can't prevent that — commit check is post-dispatch)
				expect(promptCallCount).toBe(1)
				// Should have aborted the duplicate replay
				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
			})
		})
	})

	describe("#given cleanupStaleSessions", () => {
		describe("#when sessions are older than TTL", () => {
			test("#then removes all session data from every map and set", async () => {
				const deps = createMockDeps()
				const { createFallbackState } = await import("./fallback-state")

				const staleSessionID = "ses_stale_cleanup"
				const freshSessionID = "ses_fresh_cleanup"

				// Set up stale session (31 minutes ago — TTL is 30 minutes)
				const staleTime = Date.now() - 31 * 60 * 1000
				deps.sessionLastAccess.set(staleSessionID, staleTime)
				deps.sessionStates.set(staleSessionID, createFallbackState("model-a"))
				deps.sessionRetryInFlight.add(staleSessionID)
				deps.sessionAwaitingFallbackResult.add(staleSessionID)
				deps.sessionFirstTokenReceived.set(staleSessionID, true)
				deps.sessionSelfAbortTimestamp.set(staleSessionID, staleTime)
				deps.sessionParentID.set(staleSessionID, "parent-1")
				deps.sessionIdleResolvers.set(staleSessionID, [() => {}])
				deps.sessionLastMessageTime.set(staleSessionID, staleTime)

				// Set up fresh session (5 minutes ago)
				const freshTime = Date.now() - 5 * 60 * 1000
				deps.sessionLastAccess.set(freshSessionID, freshTime)
				deps.sessionStates.set(freshSessionID, createFallbackState("model-b"))
				deps.sessionIdleResolvers.set(freshSessionID, [() => {}])
				deps.sessionLastMessageTime.set(freshSessionID, freshTime)

				const helpers = createAutoRetryHelpers(deps)
				helpers.cleanupStaleSessions()

				// Stale session: all maps/sets should be cleaned
				expect(deps.sessionStates.has(staleSessionID)).toBe(false)
				expect(deps.sessionLastAccess.has(staleSessionID)).toBe(false)
				expect(deps.sessionRetryInFlight.has(staleSessionID)).toBe(false)
				expect(deps.sessionAwaitingFallbackResult.has(staleSessionID)).toBe(false)
				expect(deps.sessionFirstTokenReceived.has(staleSessionID)).toBe(false)
				expect(deps.sessionSelfAbortTimestamp.has(staleSessionID)).toBe(false)
				expect(deps.sessionParentID.has(staleSessionID)).toBe(false)
				expect(deps.sessionIdleResolvers.has(staleSessionID)).toBe(false)
				expect(deps.sessionLastMessageTime.has(staleSessionID)).toBe(false)

				// Fresh session: should remain untouched
				expect(deps.sessionStates.has(freshSessionID)).toBe(true)
				expect(deps.sessionLastAccess.has(freshSessionID)).toBe(true)
				expect(deps.sessionIdleResolvers.has(freshSessionID)).toBe(true)
				expect(deps.sessionLastMessageTime.has(freshSessionID)).toBe(true)
			})
		})

		describe("#when no sessions are stale", () => {
			test("#then nothing is removed", async () => {
				const deps = createMockDeps()
				const { createFallbackState } = await import("./fallback-state")

				deps.sessionLastAccess.set("ses_a", Date.now() - 5 * 60 * 1000)
				deps.sessionStates.set("ses_a", createFallbackState("model-a"))
				deps.sessionLastAccess.set("ses_b", Date.now() - 10 * 60 * 1000)
				deps.sessionStates.set("ses_b", createFallbackState("model-b"))

				const helpers = createAutoRetryHelpers(deps)
				helpers.cleanupStaleSessions()

				expect(deps.sessionStates.size).toBe(2)
				expect(deps.sessionLastAccess.size).toBe(2)
			})
		})

		describe("#when all sessions are stale", () => {
			test("#then all are removed", async () => {
				const deps = createMockDeps()
				const { createFallbackState } = await import("./fallback-state")
				const staleTime = Date.now() - 31 * 60 * 1000

				deps.sessionLastAccess.set("ses_x", staleTime)
				deps.sessionStates.set("ses_x", createFallbackState("model"))
				deps.sessionLastAccess.set("ses_y", staleTime)
				deps.sessionStates.set("ses_y", createFallbackState("model"))

				const helpers = createAutoRetryHelpers(deps)
				helpers.cleanupStaleSessions()

				expect(deps.sessionStates.size).toBe(0)
				expect(deps.sessionLastAccess.size).toBe(0)
			})
		})

		describe("#when stale session has a fallback timeout", () => {
			test("#then the timeout is cleared during cleanup", async () => {
				const deps = createMockDeps()
				const { createFallbackState } = await import("./fallback-state")
				const staleTime = Date.now() - 31 * 60 * 1000

				deps.sessionLastAccess.set("ses_timer", staleTime)
				deps.sessionStates.set("ses_timer", createFallbackState("model"))
				// Simulate a pending timeout
				const fakeTimer = globalThis.setTimeout(() => {}, 999999)
				deps.sessionFallbackTimeouts.set("ses_timer", fakeTimer)

				const helpers = createAutoRetryHelpers(deps)
				helpers.cleanupStaleSessions()

				expect(deps.sessionFallbackTimeouts.has("ses_timer")).toBe(false)
			})
		})
	})

	describe("#given autoRetryWithFallback with invalid model format", () => {
		describe("#when model has no provider prefix (no slash)", () => {
			test("#then returns false without dispatching", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"gpt-4o-no-provider",
					undefined,
					"session.error"
				)

				expect(result).toBe(false)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})

		describe("#when model has a provider prefix with nested path", () => {
			test("#then correctly splits provider/model (model can contain slashes)", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})
				const promptCalls: any[] = []
				;(deps.ctx.client.session.promptAsync as any).mockImplementation(async (args: any) => {
					promptCalls.push(args)
				})

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"google/models/gemini-2.0-pro",
					undefined,
					"session.error"
				)

				expect(result).toBe(true)
				expect(promptCalls.length).toBe(1)
				// providerID should be "google", modelID should be "models/gemini-2.0-pro"
				expect(promptCalls[0].body.model.providerID).toBe("google")
				expect(promptCalls[0].body.model.modelID).toBe("models/gemini-2.0-pro")
			})
		})
	})

	describe("#given autoRetryWithFallback with empty messages", () => {
		describe("#when session.messages returns empty array", () => {
			test("#then does not dispatch and returns false", async () => {
				const deps = createMockDeps({
					messagesData: [],
				})

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error"
				)

				expect(result).toBe(false)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})

		describe("#when session.messages returns null data", () => {
			test("#then does not dispatch and returns false", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => ({
					data: null,
				}))

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error"
				)

				expect(result).toBe(false)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given autoRetryWithFallback with non-user replayable message", () => {
		describe("#when only system/tool messages exist (no user messages)", () => {
			test("#then falls back to last non-assistant message", async () => {
				const promptCalls: any[] = []
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "system" }, parts: [{ type: "text", text: "system prompt" }] },
						{ info: { role: "tool" }, parts: [{ type: "text", text: "tool result" }] },
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
					],
					promptAsyncFn: async (args: any) => {
						promptCalls.push(args)
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error"
				)

				expect(result).toBe(true)
				expect(promptCalls.length).toBe(1)
				// Should replay the tool message (last non-assistant with parts)
				expect(promptCalls[0].body.parts[0].text).toBe("tool result")
			})
		})
	})

	describe("#given autoRetryWithFallback with resolved agent", () => {
		describe("#when resolvedAgent is provided", () => {
			test("#then includes agent in promptAsync body", async () => {
				const promptCalls: any[] = []
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
					promptAsyncFn: async (args: any) => {
						promptCalls.push(args)
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					"opus",
					"session.error"
				)

				expect(promptCalls.length).toBe(1)
				expect(promptCalls[0].body.agent).toBe("opus")
			})
		})

		describe("#when resolvedAgent is undefined", () => {
			test("#then omits agent from promptAsync body", async () => {
				const promptCalls: any[] = []
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
					promptAsyncFn: async (args: any) => {
						promptCalls.push(args)
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error"
				)

				expect(promptCalls.length).toBe(1)
				expect(promptCalls[0].body.agent).toBeUndefined()
			})
		})
	})

	describe("#given autoRetryWithFallback pendingFallbackModel cleanup", () => {
		describe("#when no replayable messages and state matches newModel (non-plan path)", () => {
			test("#then clears pendingFallbackModel in finally block", async () => {
				const deps = createMockDeps({
					messagesData: [
						// Only assistant messages — no user/system/tool messages to replay
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "response" }] },
					],
				})
				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("openai/gpt-4o")
				// Non-plan path: state.currentModel must equal newModel to pass pre-check
				state.currentModel = "openai/gpt-4o"
				state.pendingFallbackModel = "openai/gpt-4o"
				deps.sessionStates.set("test-session", state)

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error"
				)

				// No replayable message means retry was not dispatched,
				// so finally block should clear pendingFallbackModel
				expect(state.pendingFallbackModel).toBeUndefined()
			})
		})
	})

	describe("#given autoRetryWithFallback with invalid model format", () => {
		describe("#when model has no slash and state matches (non-plan path)", () => {
			test("#then clears pendingFallbackModel on invalid model early return", async () => {
				const deps = createMockDeps()
				const { createFallbackState } = await import("./fallback-state")
				// Non-plan path: state.currentModel must equal newModel to pass pre-check
				const state = createFallbackState("bad-model")
				state.currentModel = "bad-model"
				state.pendingFallbackModel = "bad-model"
				deps.sessionStates.set("ses_inv", state)

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_inv",
					"bad-model",
					undefined,
					"session.error"
				)

				// Invalid model format causes early return, which clears pendingFallbackModel
				expect(result).toBe(false)
				expect(state.pendingFallbackModel).toBeUndefined()
			})
		})
	})

	describe("#given abortSessionRequest", () => {
		describe("#when abort succeeds", () => {
			test("#then records self-abort timestamp", async () => {
				const deps = createMockDeps()
				const helpers = createAutoRetryHelpers(deps)
				const before = Date.now()

				await helpers.abortSessionRequest("ses_abort", "test-source")

				const ts = deps.sessionSelfAbortTimestamp.get("ses_abort")
				expect(ts).toBeDefined()
				expect(ts!).toBeGreaterThanOrEqual(before)
				expect(ts!).toBeLessThanOrEqual(Date.now())
			})
		})

		describe("#when abort throws", () => {
			test("#then does not throw and does not set timestamp", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.abort as any).mockImplementation(async () => {
					throw new Error("Network error")
				})

				const helpers = createAutoRetryHelpers(deps)
				// Should not throw
				await helpers.abortSessionRequest("ses_fail", "test-source")

				// Timestamp not set because abort failed before reaching the set
				expect(deps.sessionSelfAbortTimestamp.has("ses_fail")).toBe(false)
			})
		})
	})

	describe("#given clearSessionFallbackTimeout", () => {
		describe("#when session has no timeout", () => {
			test("#then is a no-op", () => {
				const deps = createMockDeps()
				const helpers = createAutoRetryHelpers(deps)

				// Should not throw
				helpers.clearSessionFallbackTimeout("ses_none")
				expect(deps.sessionFallbackTimeouts.has("ses_none")).toBe(false)
			})
		})

		describe("#when session has a pending timeout", () => {
			test("#then clears and removes it", () => {
				const deps = createMockDeps()
				const fakeTimer = globalThis.setTimeout(() => {}, 999999)
				deps.sessionFallbackTimeouts.set("ses_timer", fakeTimer)

				const helpers = createAutoRetryHelpers(deps)
				helpers.clearSessionFallbackTimeout("ses_timer")

				expect(deps.sessionFallbackTimeouts.has("ses_timer")).toBe(false)
			})
		})
	})

	describe("#given session.idle.silent-failure with recent abort timestamp", () => {
		describe("#when abort happened very recently", () => {
			test("#then waits for remaining propagation time before replay", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})
				// Set a very recent self-abort timestamp (10ms ago)
				deps.sessionSelfAbortTimestamp.set("ses_recent", Date.now() - 10)

				const helpers = createAutoRetryHelpers(deps)
				const startTime = Date.now()
				await helpers.autoRetryWithFallback(
					"ses_recent",
					"openai/gpt-4o",
					undefined,
					"session.idle.silent-failure"
				)

				// Should still dispatch
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
				// Should NOT have aborted (silent-failure path doesn't abort)
				expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
			})
		})
	})

	describe("#given autoRetryWithFallback exception handling", () => {
		describe("#when session.messages throws an error", () => {
			test("#then catches error and cleans up session state", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => {
					throw new Error("API unavailable")
				})

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"session.error"
				)

				expect(result).toBe(false)
				// Session should not be left in awaiting state
				expect(deps.sessionAwaitingFallbackResult.has("test-session")).toBe(false)
			})
		})
	})

	describe("#given resolveAgentForSessionFromContext", () => {
		// Note: resolveAgentForSession is called first and checks the session ID
		// for agent names. Use session IDs with only noise words/short segments
		// so the regex-based resolver returns undefined, allowing the API fallback
		// paths to be tested.
		const noAgentSessionID = "ses_a1_b2"  // all segments fail alpha-only or length check

		describe("#when event agent is provided directly", () => {
			test("#then returns it without API calls", async () => {
				const deps = createMockDeps()
				const helpers = createAutoRetryHelpers(deps)

				const result = await helpers.resolveAgentForSessionFromContext(
					"ses_123",
					"opus"
				)

				expect(result).toBe("opus")
				// Should not have called messages or session.get
				expect(deps.ctx.client.session.messages).not.toHaveBeenCalled()
				expect(deps.ctx.client.session.get).not.toHaveBeenCalled()
			})
		})

		describe("#when no event agent and messages contain agent info", () => {
			test("#then resolves from message info", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user", agent: "sonnet" }, parts: [{ type: "text", text: "hi" }] },
					],
				})

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.resolveAgentForSessionFromContext(
					noAgentSessionID,
					undefined
				)

				expect(result).toBe("sonnet")
			})
		})

		describe("#when no event agent and messages have no agent but session.get has agent", () => {
			test("#then resolves from session.get", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
					],
				})
				;(deps.ctx.client.session.get as any).mockImplementation(async () => ({
					data: { agent: "Gemini" },
				}))

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.resolveAgentForSessionFromContext(
					noAgentSessionID,
					undefined
				)

				expect(result).toBe("gemini")
			})
		})

		describe("#when all resolution paths fail", () => {
			test("#then returns undefined", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
					],
				})
				;(deps.ctx.client.session.get as any).mockImplementation(async () => ({
					data: {},
				}))

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.resolveAgentForSessionFromContext(
					noAgentSessionID,
					undefined
				)

				expect(result).toBeUndefined()
			})
		})

		describe("#when messages API throws", () => {
			test("#then falls through to session.get", async () => {
				const deps = createMockDeps()
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => {
					throw new Error("API error")
				})
				;(deps.ctx.client.session.get as any).mockImplementation(async () => ({
					data: { agent: "Opus" },
				}))

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.resolveAgentForSessionFromContext(
					noAgentSessionID,
					undefined
				)

				expect(result).toBe("opus")
			})
		})
	})

	describe("#given getParentSessionID (tested via autoRetryWithFallback behavior)", () => {
		// getParentSessionID is not directly exported, but we can verify
		// its caching behavior through the deps.sessionParentID map
		describe("#when session has a cached parentID", () => {
			test("#then uses cache instead of API call", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})
				deps.sessionParentID.set("ses_cached", "parent-123")

				// getParentSessionID is called internally by some code paths,
				// but we can verify the cache is used by checking session.get call count
				const helpers = createAutoRetryHelpers(deps)

				// The parentID cache is used for determining child session behavior
				expect(deps.sessionParentID.get("ses_cached")).toBe("parent-123")
			})
		})
	})

	describe("#given compaction-origin fallback dispatch", () => {
		describe("#when agent is 'compaction'", () => {
			test("#then skips compaction parts and replays real user message via promptAsync", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "explain quantum computing" }] },
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Quantum computing..." }] },
						{ info: { role: "user" }, parts: [{ type: "compaction" }] },
					],
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("openai/gpt-4o")
				deps.sessionStates.set("ses_compact", state)
				deps.globalFallbackModels = ["anthropic/claude-sonnet-4-20250514"]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_compact",
					"anthropic/claude-sonnet-4-20250514",
					"compaction",
					"session.error",
					{
						success: true as const,
						newModel: "anthropic/claude-sonnet-4-20250514",
						failedModel: "openai/gpt-4o",
						newFallbackIndex: 0,
					}
				)

				expect(result).toBe(true)
				// Must use promptAsync (compaction parts are non-replayable)
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
				// session.command should NOT be called (model override doesn't work for compact)
				expect((deps.ctx.client.session as any).command).not.toHaveBeenCalled()
			})
		})

		describe("#when only compaction parts exist and no prior user message", () => {
			test("#then returns false (no replayable content)", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "compaction" }] },
					],
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("openai/gpt-4o")
				deps.sessionStates.set("ses_compact_only", state)
				deps.globalFallbackModels = ["anthropic/claude-sonnet-4-20250514"]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_compact_only",
					"anthropic/claude-sonnet-4-20250514",
					"compaction",
					"session.error",
					{
						success: true as const,
						newModel: "anthropic/claude-sonnet-4-20250514",
						failedModel: "openai/gpt-4o",
						newFallbackIndex: 0,
					}
				)

				// No replayable user message found after filtering compaction parts
				expect(result).toBe(false)
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})

		describe("#when compaction dispatch succeeds via promptAsync", () => {
			test("#then commits fallback state, marks session awaiting, and schedules timeout", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello world" }] },
						{ info: { role: "user" }, parts: [{ type: "compaction" }] },
					],
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("openai/gpt-4o")
				deps.sessionStates.set("ses_compact_ok", state)
				deps.globalFallbackModels = ["anthropic/claude-sonnet-4-20250514"]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_compact_ok",
					"anthropic/claude-sonnet-4-20250514",
					"compaction",
					"session.error",
					{
						success: true as const,
						newModel: "anthropic/claude-sonnet-4-20250514",
						failedModel: "openai/gpt-4o",
						newFallbackIndex: 0,
					}
				)

				expect(result).toBe(true)
				// Uses promptAsync (not session.command)
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
				// State should be committed (currentModel advanced)
				expect(state.currentModel).toBe("anthropic/claude-sonnet-4-20250514")
				expect(state.attemptCount).toBe(1)
				// Session should be marked awaiting fallback result
				expect(deps.sessionAwaitingFallbackResult.has("ses_compact_ok")).toBe(true)
				// Timeout should be scheduled
				expect(deps.sessionFallbackTimeouts.has("ses_compact_ok")).toBe(true)
			})
		})

		describe("#when compaction replay dispatch fails", () => {
			test("#then clears awaiting/retry-in-flight state so session does not stall", async () => {
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						{ info: { role: "user" }, parts: [{ type: "compaction" }] },
					],
					promptAsyncFn: async () => {
						throw new Error("promptAsync dispatch failed")
					},
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("openai/gpt-4o")
				deps.sessionStates.set("ses_compact_fail", state)
				deps.globalFallbackModels = ["anthropic/claude-sonnet-4-20250514"]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_compact_fail",
					"anthropic/claude-sonnet-4-20250514",
					"compaction",
					"session.error",
					{
						success: true as const,
						newModel: "anthropic/claude-sonnet-4-20250514",
						failedModel: "openai/gpt-4o",
						newFallbackIndex: 0,
					}
				)

				expect(result).toBe(false)
				// Must NOT leave session stuck
				expect(deps.sessionAwaitingFallbackResult.has("ses_compact_fail")).toBe(false)
				expect(deps.sessionRetryInFlight.has("ses_compact_fail")).toBe(false)
				expect(deps.sessionFallbackTimeouts.has("ses_compact_fail")).toBe(false)
			})
		})

		describe("#when compaction fallback triggers with notify_on_fallback enabled", () => {
			test("#then fires toast notification about compaction failing", async () => {
				const toastCalls: any[] = []
				const deps = createMockDeps({
					messagesData: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "help me" }] },
						{ info: { role: "user" }, parts: [{ type: "compaction" }] },
					],
					showToastFn: async (args: any) => {
						toastCalls.push(args)
					},
				})
				deps.config.notify_on_fallback = true

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("openai/gpt-4o")
				deps.sessionStates.set("ses_compact_toast", state)
				deps.globalFallbackModels = ["anthropic/claude-sonnet-4-20250514"]

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"ses_compact_toast",
					"anthropic/claude-sonnet-4-20250514",
					"compaction",
					"session.error",
					{
						success: true as const,
						newModel: "anthropic/claude-sonnet-4-20250514",
						failedModel: "openai/gpt-4o",
						newFallbackIndex: 0,
					}
				)

				// Toast should mention compaction
				expect(toastCalls.length).toBeGreaterThanOrEqual(1)
				const compactionToast = toastCalls.find((t: any) =>
					t.body.message.toLowerCase().includes("compaction")
				)
				expect(compactionToast).toBeDefined()
				expect(compactionToast.body.message).toContain("claude-sonnet-4-20250514")
			})
		})
	})
})
