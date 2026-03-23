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
	showToastFn: (...args: unknown[]) => Promise<void>
}>): HookDeps {
	const messagesData = overrides?.messagesData ?? []
	const promptAsyncFn = overrides?.promptAsyncFn ?? (async () => {})
	const showToastFn = overrides?.showToastFn ?? (async () => {})

	return {
		ctx: {
			directory: "/test",
			client: {
				session: {
					abort: mock(async () => {}),
					messages: mock(async () => ({ data: messagesData })),
					promptAsync: mock(promptAsyncFn as any),
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
})
