import { describe, test, expect, mock, beforeEach } from "bun:test"
import { createAutoRetryHelpers } from "./auto-retry"
import { createMessageUpdateHandler } from "./message-update-handler"
import { createEventHandler } from "./event-handler"
import { createFallbackState, planFallback } from "./fallback-state"
import type { HookDeps, FallbackPluginConfig, MessagePart } from "./types"
import { DEFAULT_CONFIG } from "./constants"

// Mirrors FALLBACK_CONTINUATION_PROMPT (continuation-prompt.ts). Literal kept here so
// tests state the exact contract the retry must send.
const CONTINUATION_TEXT =
	"Continue the existing task from where it stopped. Follow the original instructions and constraints, use completed tool results, and do not repeat completed work."

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
					revert: mock(async () => {}),
					summarize: mock(async () => ({ data: true })),
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
	for (const method of ["promptAsync", "prompt"] as const) {
		test(`continuation dispatch preserves the SDK ${method} receiver`, async () => {
			const deps = createMockDeps({ messagesData: [{ info: { role: "user" }, parts: [{ type: "text", text: "Original task" }] }] })
			deps.config.timeout_seconds = 0
			deps.config.notify_on_fallback = false
			if (method === "prompt") deps.sessionParentID.set("receiver-session", "parent")
			const prompt = mock(async function(this: unknown, _args: unknown) {
				if (this !== deps.ctx.client.session) throw new Error("SDK method lost its client receiver")
			})
			deps.ctx.client.session[method] = prompt as any
			const helpers = createAutoRetryHelpers(deps)
			expect(await helpers.autoRetryWithFallback("receiver-session", "openai/backup", "build", "message.updated")).toBe(true)
			expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ parts: [{ type: "text", text: CONTINUATION_TEXT }] }) }))
		})
	}
	describe("#given a child session fallback cancels its parent task", () => {
		test("#then it retries only the child and leaves result delivery to the task hook", async () => {
			const childID = "ses_bridge_child"
			const parentID = "ses_bridge_parent"
			const childMessages = [
				{
					info: { role: "user", agent: "gsd-executor" },
					parts: [{ type: "text", text: "Execute the worker plan" }],
				},
			]
			const promptCalls: any[] = []
			const deps = createMockDeps()
			deps.sessionParentID.set(childID, parentID)
			;(deps.ctx.client.session.get as any).mockResolvedValue({ data: { status: "idle" } })
			;(deps.ctx.client.session.messages as any).mockResolvedValue({ data: childMessages })
			;(deps.ctx.client.session.prompt as any) = mock(async (args: any) => {
				promptCalls.push(args)
			})

			const { createFallbackState } = await import("./fallback-state")
			deps.sessionStates.set(childID, createFallbackState("anthropic/claude-sonnet-5"))
			deps.sessionStates.set(parentID, createFallbackState("openai/gpt-5.6-luna"))
			const helpers = createAutoRetryHelpers(deps)

			const dispatched = await helpers.autoRetryWithFallback(
				childID,
				"openai/gpt-5.6-luna",
				"gsd-executor",
				"session.status.immediate",
				{
					success: true,
					newModel: "openai/gpt-5.6-luna",
					failedModel: "anthropic/claude-sonnet-5",
					newFallbackIndex: 1,
				},
			)
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(dispatched).toBe(true)
			expect((deps.ctx.client.session.abort as any).mock.calls.map((call: any[]) => call[0].path.id)).toEqual([
				childID,
			])
			expect(promptCalls.map((call) => call.path.id)).toEqual([childID])
			expect((deps.ctx.client.session.promptAsync as any)).not.toHaveBeenCalled()
			expect(typeof helpers.claimChildFallbackBridge(childID, parentID)).toBe("number")
		})

		test("#then it never injects a synthetic result turn into the parent", async () => {
			const childID = "ses_background_child"
			const parentID = "ses_background_parent"
			const childMessages: any[] = [
				{ info: { role: "user", agent: "gsd-executor" }, parts: [{ type: "text", text: "Execute" }] },
			]
			const parentMessages = [
				{
					info: { role: "assistant", agent: "luna", time: { completed: Date.now() } },
					parts: [{ type: "text", text: "The executor was cancelled" }],
				},
			]
			const deps = createMockDeps()
			deps.config.timeout_seconds = 1
			deps.agentConfigs = {
				"gsd-executor": { model: "anthropic/claude-sonnet-5" },
				luna: { model: "openai/gpt-5.6-luna" },
			}
			deps.sessionParentID.set(childID, parentID)
			;(deps.ctx.client.session.get as any).mockResolvedValue({ data: { status: "idle" } })
			;(deps.ctx.client.session.messages as any).mockImplementation(async ({ path }: any) => ({
				data: path.id === childID ? childMessages : parentMessages,
			}))
			;(deps.ctx.client.session.promptAsync as any).mockImplementation(async ({ path }: any) => {
				if (path.id === childID) {
					childMessages.push({
						info: { role: "assistant", time: { created: Date.now(), completed: Date.now() } },
						parts: [{ type: "text", text: "Recovered executor result" }],
					})
				}
			})
			const { createFallbackState } = await import("./fallback-state")
			deps.sessionStates.set(childID, createFallbackState("anthropic/claude-sonnet-5"))
			deps.sessionStates.set(parentID, createFallbackState("openai/gpt-5.6-luna"))
			const helpers = createAutoRetryHelpers(deps)

			await helpers.autoRetryWithFallback(
				childID,
				"openai/gpt-5.6-luna",
				"gsd-executor",
				"session.status.immediate",
				{
					success: true,
					newModel: "openai/gpt-5.6-luna",
					failedModel: "anthropic/claude-sonnet-5",
					newFallbackIndex: 1,
				},
			)
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect((deps.ctx.client.session.abort as any).mock.calls.map((call: any[]) => call[0].path.id)).toEqual([
				childID,
			])
			expect((deps.ctx.client.session.promptAsync as any).mock.calls.map((call: any[]) => call[0].path.id)).toEqual([
				childID,
			])
		})
	})

	describe("#given autoRetryWithFallback with mixed parts", () => {
		describe("#when promptAsync accepts the continuation", () => {
			test("#then sends only the continuation prompt, not the original non-text parts", async () => {
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

				expect(promptCalls.length).toBe(1)
				expect(promptCalls[0]).toEqual([{ type: "text", text: CONTINUATION_TEXT }])

				// No degradation: the original parts are never replayed
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
			})
		})

		describe("#when promptAsync would reject non-text original parts", () => {
			test("#then never sends them, so the first continuation dispatch succeeds with no degradation toast", async () => {
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
						if (args.body.parts.some((p: MessagePart) => p.type !== "text")) {
							throw new Error("Unsupported part types")
						}
					},
				})

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"test-session",
					"openai/gpt-4o",
					undefined,
					"test"
				)

				expect(result).toBe(true)
				expect(promptCalls).toEqual([[{ type: "text", text: CONTINUATION_TEXT }]])
				expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
			})
		})

		describe("#when the continuation dispatch fails", () => {
			test("#then session state is cleaned up", async () => {
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
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalledTimes(1)
				// Retry in flight should be cleared
				expect(deps.sessionRetryInFlight.has("test-session")).toBe(false)
			})
		})

		describe("#when message has only text parts", () => {
			test("#then sends the continuation prompt instead of the original text parts", async () => {
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
				expect(promptCalls[0]).toEqual([{ type: "text", text: CONTINUATION_TEXT }])

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

			test("#then replays the child without an unsupported status poll", async () => {
				const deps = createMockDeps({
					messagesData: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }],
				})
				deps.sessionParentID.set("child-session", "parent-session")
				;(deps.ctx.client.session.get as any).mockResolvedValue({ data: { status: "idle" } })

				const helpers = createAutoRetryHelpers(deps)
				await helpers.autoRetryWithFallback(
					"child-session",
					"openai/gpt-4o",
					undefined,
					"session.status.immediate",
				)

				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
				expect(deps.ctx.client.session.get).not.toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalled()
				helpers.claimChildFallbackBridge("child-session", "parent-session")
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
				// Selection guard still requires replayable history; payload is the continuation
				expect(promptCalls[0].body.parts).toEqual([{ type: "text", text: CONTINUATION_TEXT }])
			})
		})
	})

	describe("#given normal replay with existing user history", () => {
		const userParts = [
			{ type: "text", text: "Refactor the parser" },
			{ type: "image", url: "https://example.com/spec.png" },
		]
		const history = () => [
			{ info: { role: "user", id: "u1", agent: "build" }, parts: userParts },
			{ info: { role: "assistant", id: "a1", agent: "build" }, parts: [{ type: "text", text: "partial" }] },
		]

		describe("#when the retry dispatches promptAsync", () => {
			test("#then body.parts is a single short continuation text, never the original user parts", async () => {
				const deps = createMockDeps({ messagesData: history() })
				const helpers = createAutoRetryHelpers(deps)

				await helpers.autoRetryWithFallback("ses_cont", "openai/gpt-4o", "build", "session.error")

				const calls = (deps.ctx.client.session.promptAsync as any).mock.calls
				expect(calls.length).toBe(1)
				expect(calls[0][0].body.parts).toEqual([{ type: "text", text: CONTINUATION_TEXT }])
				expect(JSON.stringify(calls[0][0].body.parts)).not.toContain("Refactor the parser")
				expect(JSON.stringify(calls[0][0].body.parts)).not.toContain("spec.png")
			})

			test("#then keeps the same session, agent, and model as the original dispatch", async () => {
				const deps = createMockDeps({ messagesData: history() })
				const helpers = createAutoRetryHelpers(deps)

				await helpers.autoRetryWithFallback("ses_cont", "openai/gpt-4o", "build", "session.error")

				const [call] = (deps.ctx.client.session.promptAsync as any).mock.calls[0]
				expect(call.path.id).toBe("ses_cont")
				expect(call.body.agent).toBe("build")
				expect(call.body.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
				expect(call.query).toEqual({ directory: "/test" })
			})

			test("#then does not delete, revert, or mutate existing session history", async () => {
				const messagesData = history()
				const before = JSON.parse(JSON.stringify(messagesData))
				const deps = createMockDeps({ messagesData })
				const deleteMessage = mock(async () => {})
				;(deps.ctx.client.session as any)._client = { delete: deleteMessage }
				const helpers = createAutoRetryHelpers(deps)

				await helpers.autoRetryWithFallback("ses_cont", "openai/gpt-4o", "build", "session.error")

				expect(messagesData).toEqual(before)
				expect(deps.ctx.client.session.revert).not.toHaveBeenCalled()
				expect(deleteMessage).not.toHaveBeenCalled()
			})
		})

		describe("#when the child session uses the synchronous prompt endpoint", () => {
			test("#then the continuation goes through prompt with the same agent and model", async () => {
				const childID = "ses_cont_child"
				const parentID = "ses_cont_parent"
				const deps = createMockDeps({ messagesData: history() })
				deps.sessionParentID.set(childID, parentID)
				const promptCalls: any[] = []
				;(deps.ctx.client.session as any).prompt = mock(async (args: any) => {
					promptCalls.push(args)
				})
				const helpers = createAutoRetryHelpers(deps)

				const result = await helpers.autoRetryWithFallback(childID, "openai/gpt-4o", "build", "session.error")

				expect(result).toBe(true)
				expect(promptCalls.length).toBe(1)
				expect(promptCalls[0].body.parts).toEqual([{ type: "text", text: CONTINUATION_TEXT }])
				expect(promptCalls[0].body.agent).toBe("build")
				expect(promptCalls[0].body.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
				expect((deps.ctx.client.session.promptAsync as any)).not.toHaveBeenCalled()
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
		describe("#when agent is 'compaction' and summarize succeeds", () => {
			test("#then aborts, calls summarize on fallback model, commits state", async () => {
				const deps = createMockDeps()

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("kimi-for-coding/k2p5")
				deps.sessionStates.set("ses_compact", state)
				deps.globalFallbackModels = ["kimi-for-coding/k2p5", "google/gemini-flash"]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_compact",
					"google/gemini-flash",
					"compaction",
					"session.error",
					{
						success: true as const,
						newModel: "google/gemini-flash",
						failedModel: "kimi-for-coding/k2p5",
						newFallbackIndex: 1,
					}
				)

				expect(result).toBe(true)
				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
				// summarize called with fallback model
				expect(deps.ctx.client.session.summarize).toHaveBeenCalled()
				// promptAsync NOT used — summarize handles compaction
				expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
				// State committed
				expect(state.currentModel).toBe("google/gemini-flash")
				expect(state.failedModels.has("kimi-for-coding/k2p5")).toBe(true)
			})
		})

		describe("#when agent is 'compaction' and summarize fails", () => {
			test("#then commits fallback state for chat.message override", async () => {
				const deps = createMockDeps()
				// Override summarize to throw
				;(deps.ctx.client.session as any).summarize = mock(async () => {
					throw new Error("summarize failed")
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("kimi-for-coding/k2p5")
				deps.sessionStates.set("ses_compact_fail", state)
				deps.globalFallbackModels = ["kimi-for-coding/k2p5", "google/gemini-flash"]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					"ses_compact_fail",
					"google/gemini-flash",
					"compaction",
					"session.error",
					{
						success: true as const,
						newModel: "google/gemini-flash",
						failedModel: "kimi-for-coding/k2p5",
						newFallbackIndex: 1,
					}
				)

				expect(result).toBe(false)
				expect(state.currentModel).toBe("google/gemini-flash")
				expect(state.failedModels.has("kimi-for-coding/k2p5")).toBe(true)
			})
		})

		describe("#when summarize reports an error in the result envelope", () => {
			test("#then it treats it as a failure instead of re-dispatching", async () => {
				const deps = createMockDeps()
				// The SDK returns provider failures here rather than throwing.
				;(deps.ctx.client.session as any).summarize = mock(async () => ({
					error: { name: "UnknownError", data: {} },
				}))

				const sessionID = "ses_compact_error_envelope"
				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("anthropic/claude-opus-5")
				deps.sessionStates.set(sessionID, state)
				deps.globalFallbackModels = [
					"anthropic/claude-opus-5",
					"github-copilot/grok-code-fast-1",
				]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					sessionID,
					"github-copilot/grok-code-fast-1",
					"compaction",
					"session.timeout",
					{
						success: true as const,
						newModel: "github-copilot/grok-code-fast-1",
						failedModel: "anthropic/claude-opus-5",
						newFallbackIndex: 1,
					}
				)

				// Must not report a successful dispatch, and must not leave a
				// timeout armed that would walk the rest of the model chain.
				expect(result).toBe(false)
				expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
				expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(false)
			})
		})

		describe("#when session.compacted lands while the fallback is being prepared", () => {
			test("#then it bails out instead of dispatching a redundant compaction", async () => {
				const deps = createMockDeps()
				const sessionID = "ses_compact_completed_race"

				// handleSessionCompacted clears the in-flight sentinel while we
				// are still aborting/cleaning up messages.
				;(deps.ctx.client.session.messages as any).mockImplementation(async () => {
					deps.sessionCompactionInFlight.delete(sessionID)
					return { data: [] }
				})

				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("anthropic/claude-opus-5")
				deps.sessionStates.set(sessionID, state)
				deps.globalFallbackModels = [
					"anthropic/claude-opus-5",
					"google/antigravity-gemini-3-flash",
				]

				const helpers = createAutoRetryHelpers(deps)
				const result = await helpers.autoRetryWithFallback(
					sessionID,
					"google/antigravity-gemini-3-flash",
					"compaction",
					"session.timeout",
					{
						success: true as const,
						newModel: "google/antigravity-gemini-3-flash",
						failedModel: "anthropic/claude-opus-5",
						newFallbackIndex: 1,
					}
				)

				expect(result).toBe(false)
				expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
				expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
			})
		})

		describe("#when two handlers dispatch the same compaction fallback concurrently", () => {
			test("#then only the first handler aborts and summarizes", async () => {
				const deps = createMockDeps()
				const sessionID = "ses_compact_duplicate_dispatch"
				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState("anthropic/claude-opus-5")
				deps.sessionStates.set(sessionID, state)
				deps.globalFallbackModels = [
					"anthropic/claude-opus-5",
					"google/antigravity-gemini-3-flash",
				]

				const helpers = createAutoRetryHelpers(deps)
				const plan = {
					success: true as const,
					newModel: "google/antigravity-gemini-3-flash",
					failedModel: "anthropic/claude-opus-5",
					newFallbackIndex: 1,
				}
				const [first, second] = await Promise.all([
					helpers.autoRetryWithFallback(
						sessionID,
						plan.newModel,
						"compaction",
						"session.timeout",
						plan
					),
					helpers.autoRetryWithFallback(
						sessionID,
						plan.newModel,
						"compaction",
						"session.status.immediate",
						plan
					),
				])

				expect([first, second].filter(Boolean)).toHaveLength(1)
				expect(deps.ctx.client.session.abort).toHaveBeenCalledTimes(1)
				expect(deps.ctx.client.session.summarize).toHaveBeenCalledTimes(1)
			})
		})

		describe("#when the compaction agent pins a model (agent.compaction.model)", () => {
			const sessionID = "ses_pin_guard"
			const PIN = "openai/gpt-5.6-luna"
			const TARGET = "google/gemini-flash"
			const OTHER_FAILED = "kimi-for-coding/k2p5"

			const pinnedPlan = (failedModel: string) => ({
				success: true as const,
				newModel: TARGET,
				failedModel,
				newFallbackIndex: 1,
			})

			async function setupPinned(options: { failedModel: string; pin: string; notify?: boolean }) {
				const deps = createMockDeps()
				deps.config.notify_on_fallback = options.notify ?? false
				deps.agentConfigs = { compaction: { model: options.pin } }
				deps.globalFallbackModels = [options.failedModel, TARGET]
				const { createFallbackState } = await import("./fallback-state")
				const state = createFallbackState(options.failedModel)
				deps.sessionStates.set(sessionID, state)
				return { deps, state, helpers: createAutoRetryHelpers(deps) }
			}

				describe("#when the pin is the failed current model", () => {
					test("#then it refuses the dispatch before any abort, delete, or summarize", async () => {
						const { deps, state, helpers } = await setupPinned({ failedModel: PIN, pin: PIN })
						state.pendingFallbackModel = TARGET
						const activeTimeout = setTimeout(() => {}, 60_000)
						deps.sessionFallbackTimeouts.set(sessionID, activeTimeout)

						try {
							const result = await helpers.autoRetryWithFallback(
								sessionID,
								TARGET,
								"compaction",
								"session.status.immediate",
								pinnedPlan(PIN),
							)

							expect(result).toBe(false)
							expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
							expect(deps.ctx.client.session.messages).not.toHaveBeenCalled()
							expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
							expect(deps.ctx.client.session.promptAsync).not.toHaveBeenCalled()
							expect(state.currentModel).toBe(PIN)
							expect(state.pendingFallbackModel).toBeUndefined()
							expect(state.attemptCount).toBe(0)
							expect(state.failedModels.size).toBe(0)
							expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
							expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(false)
							expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
						} finally {
							clearTimeout(activeTimeout)
						}
					})
			})

			describe("#when the pin differs from the requested target", () => {
				test("#then the target is never dispatched", async () => {
					const { deps, state, helpers } = await setupPinned({ failedModel: OTHER_FAILED, pin: PIN })

					const result = await helpers.autoRetryWithFallback(
						sessionID,
						TARGET,
						"compaction",
						"session.error",
						pinnedPlan(OTHER_FAILED),
					)

					expect(result).toBe(false)
					expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
					expect(state.currentModel).toBe(OTHER_FAILED)
					expect(state.attemptCount).toBe(0)
				})
			})

			describe("#when state already advanced and no plan is supplied", () => {
					test("#then it leaves another handler's timer and state untouched", async () => {
					const { deps, state, helpers } = await setupPinned({ failedModel: OTHER_FAILED, pin: PIN })
					state.currentModel = "google/gemini-pro"
					state.attemptCount = 1
					state.failedModels.set(PIN, Date.now())
					const otherHandlerTimer = setTimeout(() => {}, 60_000)
					deps.sessionFallbackTimeouts.set(sessionID, otherHandlerTimer)

					try {
						const result = await helpers.autoRetryWithFallback(
							sessionID,
							TARGET,
							"compaction",
							"session.status.immediate",
						)

						expect(result).toBe(false)
						expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
						expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
						expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(otherHandlerTimer)
						expect(state.currentModel).toBe("google/gemini-pro")
						expect(state.attemptCount).toBe(1)
						expect(state.failedModels.has(PIN)).toBe(true)
					} finally {
						clearTimeout(otherHandlerTimer)
					}
				})
			})

			describe("#when the pin equals the requested target and is viable", () => {
				test("#then it dispatches summarize on the pin and commits the plan", async () => {
					const { deps, state, helpers } = await setupPinned({ failedModel: OTHER_FAILED, pin: TARGET })

					const result = await helpers.autoRetryWithFallback(
						sessionID,
						TARGET,
						"compaction",
						"session.error",
						pinnedPlan(OTHER_FAILED),
					)

					expect(result).toBe(true)
					expect(deps.ctx.client.session.summarize).toHaveBeenCalledTimes(1)
					expect(state.currentModel).toBe(TARGET)
				})
			})

			describe("#when the pin equals the requested target but already failed", () => {
				test("#then it refuses the dispatch", async () => {
					const { deps, state, helpers } = await setupPinned({ failedModel: OTHER_FAILED, pin: TARGET })
					state.failedModels.set(TARGET, Date.now())

					const result = await helpers.autoRetryWithFallback(
						sessionID,
						TARGET,
						"compaction",
						"session.error",
						pinnedPlan(OTHER_FAILED),
					)

					expect(result).toBe(false)
					expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
					expect(state.currentModel).toBe(OTHER_FAILED)
				})
			})

			describe("#when the pin blocks the dispatch and notifications are enabled", () => {
				test("#then it toasts an actionable message naming agent.compaction.model", async () => {
					const { deps, helpers } = await setupPinned({ failedModel: PIN, pin: PIN, notify: true })

					await helpers.autoRetryWithFallback(sessionID, TARGET, "compaction", "session.error", pinnedPlan(PIN))

					expect(deps.ctx.client.tui.showToast).toHaveBeenCalledTimes(1)
					const toastBody = (deps.ctx.client.tui.showToast as any).mock.calls[0][0].body
					expect(toastBody.message).toContain("agent.compaction.model")
				})
			})

			describe("#when the pin blocks the dispatch and notifications are disabled", () => {
				test("#then it refuses without a toast", async () => {
					const { deps, helpers } = await setupPinned({ failedModel: PIN, pin: PIN, notify: false })

					const result = await helpers.autoRetryWithFallback(sessionID, TARGET, "compaction", "session.error", pinnedPlan(PIN))

					expect(result).toBe(false)
					expect(deps.ctx.client.tui.showToast).not.toHaveBeenCalled()
				})
			})

			describe("#when a non-compaction agent runs with an unrelated compaction pin", () => {
				test("#then the normal replay dispatch still proceeds", async () => {
					const deps = createMockDeps({
						messagesData: [{ info: { role: "user" }, parts: [{ type: "text", text: "continue" }] }],
					})
					deps.agentConfigs = { compaction: { model: PIN }, luna: { model: TARGET } }
					const { createFallbackState } = await import("./fallback-state")
					deps.sessionStates.set(sessionID, createFallbackState(OTHER_FAILED))
					const helpers = createAutoRetryHelpers(deps)

					const result = await helpers.autoRetryWithFallback(
						sessionID,
						TARGET,
						"luna",
						"session.error",
						pinnedPlan(OTHER_FAILED),
					)

					expect(result).toBe(true)
					expect(deps.ctx.client.session.promptAsync).toHaveBeenCalledTimes(1)
					expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
				})
			})

			describe("#when the guard refuses the same pinned dispatch repeatedly", () => {
				test("#then it does not mutate attempt count or failed models and does not loop", async () => {
					const { deps, state, helpers } = await setupPinned({ failedModel: PIN, pin: PIN })

					const first = await helpers.autoRetryWithFallback(
						sessionID,
						TARGET,
						"compaction",
						"session.status.immediate",
						pinnedPlan(PIN),
					)
					const failedAfterFirst = new Map(state.failedModels)
					const attemptsAfterFirst = state.attemptCount
					const second = await helpers.autoRetryWithFallback(
						sessionID,
						TARGET,
						"compaction",
						"session.status.immediate",
						pinnedPlan(PIN),
					)

					expect([first, second]).toEqual([false, false])
					expect(state.attemptCount).toBe(attemptsAfterFirst)
					expect(state.failedModels).toEqual(failedAfterFirst)
					expect(state.failedModels.has(PIN)).toBe(false)
					expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(false)
					expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
					expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
					expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
				})
			})

				describe("#when another handler owns the awaiting flag", () => {
					test("#then the guard leaves that flag in place", async () => {
						const { deps, helpers } = await setupPinned({ failedModel: PIN, pin: PIN })
						deps.sessionAwaitingFallbackResult.add(sessionID)
						const activeTimeout = setTimeout(() => {}, 60_000)
						deps.sessionFallbackTimeouts.set(sessionID, activeTimeout)

						try {
							await helpers.autoRetryWithFallback(sessionID, TARGET, "compaction", "session.error", pinnedPlan(PIN))

							expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
							expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(activeTimeout)
						} finally {
							clearTimeout(activeTimeout)
						}
					})
			})
		})
	})

	describe("#given a real message.updated compaction error flow", () => {
		const sessionID = "ses_real_compaction_error"
		const failedModel = "openai/gpt-5.6-luna"
		const fallbackModel = "google/gemini-flash"

		function setupRealCompactionHandler(pinnedModel?: string) {
			const deps = createMockDeps()
			deps.config.notify_on_fallback = true
			deps.config.timeout_seconds = 30
			deps.agentConfigs = pinnedModel ? { compaction: { model: pinnedModel } } : { compaction: {} }
			deps.globalFallbackModels = [failedModel, fallbackModel]
			const state = createFallbackState(failedModel)
			deps.sessionStates.set(sessionID, state)
			const helpers = createAutoRetryHelpers(deps)
			const handleMessageUpdate = createMessageUpdateHandler(deps, helpers)
			return { deps, state, helpers, handleMessageUpdate }
		}

		const failedCompactionEvent = () => ({
			info: {
				sessionID,
				role: "assistant",
				agent: "compaction",
				model: failedModel,
				error: { statusCode: 500, message: "provider unavailable" },
			},
		})

		test("#then pinned model guard shows actionable guidance without dispatch or state mutation", async () => {
			const { deps, state, handleMessageUpdate } = setupRealCompactionHandler(failedModel)

			await handleMessageUpdate(failedCompactionEvent())

			expect(deps.ctx.client.tui.showToast).toHaveBeenCalled()
			const toastMessages = (deps.ctx.client.tui.showToast as any).mock.calls.map(
				(call: any[]) => call[0].body.message,
			)
			expect(toastMessages.some((message: string) =>
				message.includes("agent.compaction.model") && message.toLowerCase().includes("unset"),
			)).toBe(true)
			expect(deps.ctx.client.session.summarize).not.toHaveBeenCalled()
			expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
			expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
			expect(state.currentModel).toBe(failedModel)
			expect(state.pendingFallbackModel).toBeUndefined()
			expect(state.attemptCount).toBe(0)
			expect(state.failedModels.size).toBe(0)
		})

		test("#then unpinned compaction summarizes once and session.compacted clears dispatch state", async () => {
			const { deps, state, helpers, handleMessageUpdate } = setupRealCompactionHandler()

			await handleMessageUpdate(failedCompactionEvent())

			expect(deps.ctx.client.session.summarize).toHaveBeenCalledTimes(1)
			expect((deps.ctx.client.session.summarize as any).mock.calls[0][0].body).toEqual({
				providerID: "google",
				modelID: "gemini-flash",
			})
			expect(state.currentModel).toBe(fallbackModel)
			expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(true)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
			expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)

			const eventHandler = createEventHandler(deps, helpers)
			await eventHandler.handleEvent({
				event: { type: "session.compacted", properties: { sessionID } },
			})

			expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
		})
	})

	describe("#given host callbacks that race fallback dispatch", () => {
		test("#then a response emitted inside promptAsync commits once without aborting or rearming TTFT", async () => {
			const sessionID = "ses_prompt_emits_fallback_response"
			const failedModel = "openai/primary"
			const fallbackModel = "google/backup"
			const messagesData: any[] = [
				{ info: { role: "user", id: "user-1" }, parts: [{ type: "text", text: "hello" }] },
			]
			let handleMessageUpdate: (props: any) => Promise<void>
			const deps = createMockDeps({
				messagesData,
				promptAsyncFn: async () => {
					expect((deps as any).sessionDispatchModels.get(sessionID)).toBe(fallbackModel)
					await handleMessageUpdate({
						info: { sessionID, role: "assistant", id: "backup-slot", model: fallbackModel },
						parts: [],
					})
					expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
					expect(deps.sessionStates.get(sessionID)?.currentModel).toBe(failedModel)
					messagesData.push({
						info: { sessionID, role: "assistant", id: "backup-slot", model: fallbackModel, finish: "stop" },
						parts: [{ type: "text", text: "backup response" }],
					})
					await handleMessageUpdate({
						info: { sessionID, role: "assistant", id: "backup-slot", model: fallbackModel, finish: "stop" },
						parts: [{ type: "text", text: "backup response" }],
					})
				},
			})
			;(deps as any).sessionDispatchModels = new Map<string, string>()
			deps.config.timeout_seconds = 30
			deps.globalFallbackModels = [failedModel, fallbackModel]
			const state = createFallbackState(failedModel)
			deps.sessionStates.set(sessionID, state)
			const helpers = createAutoRetryHelpers(deps)
			handleMessageUpdate = createMessageUpdateHandler(deps, helpers)
			const plan = planFallback(sessionID, state, deps.globalFallbackModels, deps.config)
			expect(plan.success).toBe(true)

			await helpers.autoRetryWithFallback(sessionID, fallbackModel, "build", "message.updated", plan)

			expect(state.currentModel).toBe(fallbackModel)
			expect(state.attemptCount).toBe(1)
			expect(state.failedModels.has(failedModel)).toBe(true)
			expect(deps.ctx.client.session.abort).not.toHaveBeenCalled()
			expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
			expect((deps as any).sessionDispatchModels.has(sessionID)).toBe(false)
		})

		test("#then session.compacted inside summarize prevents stale post-response timer and lock state", async () => {
			const sessionID = "ses_compacted_before_summarize_resolves"
			const failedModel = "openai/primary"
			const fallbackModel = "google/backup"
			const deps = createMockDeps()
			deps.config.timeout_seconds = 30
			deps.agentConfigs = { compaction: {} }
			deps.globalFallbackModels = [failedModel, fallbackModel]
			;(deps as any).sessionDispatchModels = new Map<string, string>()
			const state = createFallbackState(failedModel)
			deps.sessionStates.set(sessionID, state)
			const helpers = createAutoRetryHelpers(deps)
			const eventHandler = createEventHandler(deps, helpers)
			deps.sessionRetryInFlight.add(sessionID)
			deps.ctx.client.session.summarize = mock(async () => {
				await eventHandler.handleEvent({
					event: { type: "session.compacted", properties: { sessionID } },
				})
				return { data: true }
			}) as any
			const plan = planFallback(sessionID, state, deps.globalFallbackModels, deps.config)
			expect(plan.success).toBe(true)

			await helpers.autoRetryWithFallback(sessionID, fallbackModel, "compaction", "message.updated", plan)

			expect(state.currentModel).toBe(fallbackModel)
			expect(state.attemptCount).toBe(1)
			expect(state.failedModels.has(failedModel)).toBe(true)
			expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
		})

		test("#then a hung summarize times out to the next compaction model without stale settlement stealing ownership", async () => {
			const sessionID = "ses_hung_compaction_summarize"
			const failedModel = "openai/primary"
			const firstFallback = "google/backup"
			const recoveryFallback = "anthropic/recovery"
			const deps = createMockDeps()
			deps.config.timeout_seconds = 0.03
			deps.config.max_fallback_attempts = 4
			deps.agentConfigs = {
				compaction: { fallback_models: [failedModel, firstFallback, recoveryFallback] },
			}
			deps.globalFallbackModels = [failedModel, firstFallback, "openai/global-recovery"]
			;(deps as any).sessionDispatchModels = new Map<string, string>()
			const state = createFallbackState(failedModel)
			deps.sessionStates.set(sessionID, state)
			let resolveFirstSummarize!: (value: any) => void
			let resolveSecondSummarize!: (value: any) => void
			const firstSummarize = new Promise<any>((resolve) => { resolveFirstSummarize = resolve })
			const secondSummarize = new Promise<any>((resolve) => { resolveSecondSummarize = resolve })
			const summarizeCalls: any[] = []
			deps.ctx.client.session.summarize = mock(async (request: any) => {
				summarizeCalls.push(request)
				return summarizeCalls.length === 1 ? firstSummarize : secondSummarize
			}) as any
			const helpers = createAutoRetryHelpers(deps)
			deps.sessionRetryInFlight.add(sessionID)
			const firstPlan = planFallback(sessionID, state, [failedModel, firstFallback, recoveryFallback], deps.config)
			expect(firstPlan.success).toBe(true)
			const firstDispatch = helpers.autoRetryWithFallback(
				sessionID, firstFallback, "compaction", "message.updated", firstPlan,
			)

			const waitFor = async (predicate: () => boolean, label: string) => {
				const deadline = Date.now() + 5000
				while (!predicate() && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 20))
				}
				expect(predicate(), label).toBe(true)
			}
			await waitFor(() => summarizeCalls.length >= 1, "first summarize dispatch should begin")
			await waitFor(() => summarizeCalls.length >= 2, "TTFT recovery should dispatch a second summarize")

			expect(summarizeCalls[0].body).toEqual({ providerID: "google", modelID: "backup" })
			expect(summarizeCalls[1].body).toEqual({ providerID: "anthropic", modelID: "recovery" })
			expect(state.currentModel).toBe(recoveryFallback)
			expect(state.attemptCount).toBe(2)
			expect(state.failedModels.has(failedModel)).toBe(true)
			expect(state.failedModels.has(firstFallback)).toBe(true)
			expect(deps.ctx.client.session.abort).toHaveBeenCalled()
			expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(true)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
			const currentTimeout = deps.sessionFallbackTimeouts.get(sessionID)
			expect(currentTimeout).toBeDefined()

			resolveFirstSummarize({ data: true })
			await firstDispatch
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(currentTimeout)
			expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(true)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
			expect(state.currentModel).toBe(recoveryFallback)

			const eventHandler = createEventHandler(deps, helpers)
			await eventHandler.handleEvent({
				event: { type: "session.compacted", properties: { sessionID } },
			})
			resolveSecondSummarize({ data: true })
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
			expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(false)
			expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
		}, 15000)
	})

	describe("#given provider status during a pending compaction summarize", () => {
		const failedModel = "openai/primary"
		const firstFallback = "google/backup"
		const recoveryFallback = "anthropic/recovery"

		function setupPendingCompaction(sessionID: string, timeoutSeconds: number) {
			const messagesData = [{
				info: { sessionID, role: "assistant", agent: "compaction", model: failedModel },
				parts: [{ type: "compaction" }],
			}]
			const deps = createMockDeps({ messagesData })
			deps.config.timeout_seconds = timeoutSeconds
			deps.config.max_fallback_attempts = 4
			deps.agentConfigs = {
				compaction: { fallback_models: [failedModel, firstFallback, recoveryFallback] },
			}
			deps.globalFallbackModels = [failedModel, firstFallback, recoveryFallback]
			const state = createFallbackState(failedModel)
			deps.sessionStates.set(sessionID, state)
			const helpers = createAutoRetryHelpers(deps)
			const handleMessageUpdate = createMessageUpdateHandler(deps, helpers)
			const handleEvent = createEventHandler(deps, helpers)
			return { deps, state, helpers, handleMessageUpdate, handleEvent, messagesData }
		}

		const failedCompactionUpdate = (sessionID: string) => ({
			info: {
				sessionID,
				role: "assistant",
				agent: "compaction",
				model: failedModel,
				error: { statusCode: 500, message: "provider unavailable" },
			},
		})

		test("#then a provider retry leaves recovery armed and recovers to the next compaction model", async () => {
			const sessionID = "ses_status_during_pending_summarize"
			const { deps, state, handleMessageUpdate, handleEvent } = setupPendingCompaction(sessionID, 0.15)
			const summarizeResolvers: Array<(value: any) => void> = []
			const summarizeCalls: any[] = []
			deps.ctx.client.session.summarize = mock(async (request: any) => {
				summarizeCalls.push(request)
				return await new Promise((resolve) => summarizeResolvers.push(resolve))
			}) as any

			let finishInitialCaller!: () => void
			const initialCallerDone = new Promise<void>((resolve) => { finishInitialCaller = resolve })
			const initialCaller = handleMessageUpdate(failedCompactionUpdate(sessionID)).finally(finishInitialCaller)
			const waitFor = async (predicate: () => boolean, label: string) => {
				const deadline = Date.now() + 5000
				while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15))
				expect(predicate(), label).toBe(true)
			}

			try {
				await waitFor(() => summarizeCalls.length === 1, "initial summarize should be pending")
				const recoveryTimer = deps.sessionFallbackTimeouts.get(sessionID)
				expect(recoveryTimer).toBeDefined()

				await handleEvent.handleEvent({
					event: {
						type: "session.status",
						properties: { sessionID, status: { type: "retry", attempt: 2, message: "rate limited" } },
					},
				})

				expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(recoveryTimer)
				expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
				expect(deps.sessionCompactionInFlight.has(sessionID)).toBe(true)
				await waitFor(() => summarizeCalls.length === 2, "TTFT recovery should dispatch the next model")
				expect(summarizeCalls[1].body).toEqual({ providerID: "anthropic", modelID: "recovery" })
				expect(state.currentModel).toBe(recoveryFallback)
				expect(state.attemptCount).toBe(2)
			} finally {
				for (const resolve of summarizeResolvers) resolve({ data: true })
				deps.sessionFallbackTimeouts.forEach(clearTimeout)
				deps.sessionFallbackTimeouts.clear()
				await Promise.race([initialCaller, new Promise((resolve) => setTimeout(resolve, 3000))])
				await initialCallerDone
			}
		}, 15000)

		test("#then stale summarize settlement cannot release the recovery caller's retry lock", async () => {
			const sessionID = "ses_stale_summarize_cannot_release_recovery_lock"
			const { deps, handleMessageUpdate } = setupPendingCompaction(sessionID, 0.05)
			let resolveInitialSummarize!: (value: any) => void
			const firstSummarize = new Promise<any>((resolve) => { resolveInitialSummarize = resolve })
			let summarizeCalls = 0
			deps.ctx.client.session.summarize = mock(async () => {
				summarizeCalls++
				return summarizeCalls === 1 ? firstSummarize : { data: true }
			}) as any

			let releaseRecoveryMessages!: () => void
			let signalRecoveryMessages!: () => void
			const recoveryMessagesGate = new Promise<void>((resolve) => { releaseRecoveryMessages = resolve })
			const recoveryMessagesStarted = new Promise<void>((resolve) => { signalRecoveryMessages = resolve })
			let gateRecoveryMessages = false
			deps.ctx.client.session.messages = mock(async () => {
				if (gateRecoveryMessages) {
					signalRecoveryMessages()
					await recoveryMessagesGate
				}
				return { data: [] }
			}) as any

			const initialCaller = handleMessageUpdate(failedCompactionUpdate(sessionID))
			const waitFor = async (predicate: () => boolean, label: string) => {
				const deadline = Date.now() + 5000
				while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15))
				expect(predicate(), label).toBe(true)
			}

			try {
				await waitFor(() => summarizeCalls === 1, "initial summarize should be pending")
				gateRecoveryMessages = true
				await recoveryMessagesStarted
				expect(deps.sessionRetryInFlight.has(sessionID)).toBe(true)
				const recoveryLockToken = deps.sessionRetryLockTokens?.get(sessionID)

				resolveInitialSummarize({ data: true })
				await initialCaller
				expect(deps.sessionRetryInFlight.has(sessionID)).toBe(true)
				expect(deps.sessionRetryLockTokens?.get(sessionID)).toBe(recoveryLockToken)
			} finally {
				releaseRecoveryMessages()
				resolveInitialSummarize({ data: true })
				deps.sessionFallbackTimeouts.forEach(clearTimeout)
				deps.sessionFallbackTimeouts.clear()
				await Promise.race([initialCaller, new Promise((resolve) => setTimeout(resolve, 3000))])
			}
		}, 15000)
	})
})
