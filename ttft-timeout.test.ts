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
		sessionCompactionInFlight: new Set(),
	}
}

function createMockHelpers(): AutoRetryHelpers {
	return {
		abortSessionRequest: mock(async () => {}),
		clearSessionFallbackTimeout: mock(() => {}),
		scheduleSessionFallbackTimeout: mock(() => {}),
		autoRetryWithFallback: mock(async () => {}),
		resolveAgentForSessionFromContext: mock(async () => undefined),
		getParentSessionID: mock(async () => null),
		cleanupStaleSessions: mock(() => {}),
	} as unknown as AutoRetryHelpers
}

describe("TTFT-based timeout", () => {
	describe("request-scoped first-token tracking (issue #6)", () => {
		const sessionID = "ses_request_scope"
		const primary = "openai/primary"
		const frame = (id: string, agent = "build", parts: any[] = []) => ({
			info: { id, sessionID, role: "assistant", model: primary, agent }, parts,
		})
		const fixture = () => {
			const deps = createMockDeps()
			deps.globalFallbackModels = ["openai/backup"]
			deps.ctx.client.session.messages = mock(async () => ({ data: [] })) as any
			const helpers = createMockHelpers()
			helpers.resolveAgentForSessionFromContext = mock(async (_id, agent) => agent)
			return { deps, helpers, messages: createMessageUpdateHandler(deps, helpers), events: createEventHandler(deps, helpers).handleEvent }
		}

		test("a successful turn going idle rearms TTFT for a silent later turn", async () => {
			const f = fixture()
			await f.messages(frame("msg_first", "build", [{ type: "text", text: "Done" }]))
			await f.events({ event: { type: "session.idle", properties: { sessionID } } })
			await f.messages(frame("msg_second"))
			await Bun.sleep(0)
			expect(f.helpers.scheduleSessionFallbackTimeout).toHaveBeenCalledWith(sessionID, "build")
		})

		test("status idle ends fallback tracking and the next request gets a fresh window", async () => {
			const f = fixture()
			f.deps.sessionStates.set(sessionID, createFallbackState(primary))
			f.deps.sessionFirstTokenReceived.set(sessionID, true)
			f.deps.sessionAwaitingFallbackResult.add(sessionID)
			await f.events({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } })
			expect(f.deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
			await f.messages(frame("msg_next"))
			await Bun.sleep(0)
			expect(f.helpers.scheduleSessionFallbackTimeout).toHaveBeenCalledWith(sessionID, "build")
		})

		for (const end of ["session.idle", "session.stop", "session.deleted", "message.completed"]) {
			test(`deferred agent resolution cannot arm TTFT after ${end}`, async () => {
				const f = fixture()
				let resolve!: (agent: string) => void
				f.helpers.resolveAgentForSessionFromContext = mock(() => new Promise<string>((done) => { resolve = done }))
				await f.messages(frame("msg_pending"))
				if (end === "message.completed") {
					await f.messages({ ...frame("msg_pending"), info: { ...frame("msg_pending").info, finish: "stop" } })
				} else {
					await f.events({ event: { type: end, properties: end === "session.deleted" ? { info: { id: sessionID } } : { sessionID } } })
				}
				resolve("build")
				await Bun.sleep(0)
				expect(f.helpers.scheduleSessionFallbackTimeout).not.toHaveBeenCalled()
			})
		}

		test("a delayed provider retry after successful idle cannot replay a finished turn", async () => {
			const f = fixture()
			f.deps.ctx.client.session.messages = mock(async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Done" }] }] })) as any
			await f.messages(frame("msg_done", "build", [{ type: "text", text: "Done" }]))
			await f.events({ event: { type: "session.idle", properties: { sessionID } } })
			await f.events({ event: { type: "session.status", properties: { sessionID, status: { type: "retry", message: "Too many requests" } } } })
			expect(f.helpers.autoRetryWithFallback).not.toHaveBeenCalled()
		})

		test("silent auto-compaction attributes failure to its own model, not the chat model", async () => {
			const f = fixture()
			await f.messages(frame("msg_chat", "build", [{ type: "text", text: "Working" }]))
			await f.messages({ ...frame("msg_compact", "compaction"), info: { ...frame("msg_compact", "compaction").info, model: "openai/compaction-primary" } })
			await Bun.sleep(0)
			expect(f.deps.sessionStates.get(sessionID)?.currentModel).toBe("openai/compaction-primary")
			expect(f.deps.sessionStates.get(sessionID)?.originalModel).toBe(primary)
		})

		test("auto-compaction mid-turn arms a fresh TTFT window only once per message", async () => {
			const f = fixture()
			await f.messages(frame("msg_first", "build", [{ type: "text", text: "Working" }]))
			await f.messages(frame("msg_compact", "compaction"))
			await Bun.sleep(0)
			expect(f.helpers.scheduleSessionFallbackTimeout).toHaveBeenCalledTimes(1)
			expect(f.helpers.scheduleSessionFallbackTimeout).toHaveBeenCalledWith(sessionID, "compaction")
			await f.messages(frame("msg_compact", "compaction", [{ type: "text", text: "Summary" }]))
			await f.messages(frame("msg_compact", "compaction"))
			await Bun.sleep(0)
			expect(f.deps.sessionFirstTokenReceived.get(sessionID)).toBe(true)
			expect(f.helpers.scheduleSessionFallbackTimeout).toHaveBeenCalledTimes(1)
		})

		test("a new tool-loop assistant request is timed even without an idle event", async () => {
			const f = fixture()
			await f.messages(frame("msg_tool", "build", [{ type: "tool", name: "read" }]))
			await f.messages(frame("msg_after_tool"))
			await Bun.sleep(0)
			expect(f.helpers.scheduleSessionFallbackTimeout).toHaveBeenCalledWith(sessionID, "build")
		})

		test("a later silent request actually times out and dispatches backup", async () => {
			const deps = createMockDeps({ timeout_seconds: 0.01, notify_on_fallback: false })
			deps.globalFallbackModels = ["openai/backup"]
			deps.ctx.client.session.messages = mock(async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "Continue" }] }] })) as any
			const helpers = createAutoRetryHelpers(deps)
			const messages = createMessageUpdateHandler(deps, helpers)
			await messages(frame("msg_first", "build", [{ type: "text", text: "Done" }]))
			await createEventHandler(deps, helpers).handleEvent({ event: { type: "session.idle", properties: { sessionID } } })
			await messages(frame("msg_second"))
			try {
				for (let i = 0; i < 100 && !(deps.ctx.client.session.promptAsync as any).mock.calls.length; i++) await Bun.sleep(10)
				expect(deps.ctx.client.session.abort).toHaveBeenCalled()
				expect(deps.ctx.client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ model: { providerID: "openai", modelID: "backup" } }) }))
			} finally {
				helpers.clearSessionFallbackTimeout(sessionID)
			}
		})
	})
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
			test("#then sessionFirstTokenReceived is set for first-event content", async () => {
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

				expect(deps.sessionFirstTokenReceived.get("test-session")).toBe(true)
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

describe("TTFT reviewer findings: request-scoped timeout races", () => {
	const sessionID = "ses_reviewer_findings"
	const primary = "openai/primary"
	const frame = (id: string, agent = "build", parts: any[] = [], extra: Record<string, unknown> = {}) => ({
		info: { id, sessionID, role: "assistant", model: primary, agent, ...extra }, parts,
	})
	const gated = () => {
		let release!: (value: unknown) => void
		const promise = new Promise((resolve) => { release = resolve })
		return { promise, release }
	}
	const realTimer = () => setTimeout(() => {}, 3_600_000)

	describe("finding 1: completed/error update during active compaction keeps the real timeout", () => {
		test("completed update while compaction in-flight and awaiting preserves timeout identity", async () => {
			const deps = createMockDeps({ timeout_seconds: 3600 })
			deps.ctx.client.session.messages = mock(async () => ({ data: [] })) as any
			const helpers = createAutoRetryHelpers(deps)
			const messages = createMessageUpdateHandler(deps, helpers)
			deps.sessionCompactionInFlight.add(sessionID)
			deps.sessionAwaitingFallbackResult.add(sessionID)
			deps.sessionRequestMessages!.set(sessionID, "msg_compact")
			deps.sessionActiveRequests!.set(sessionID, "msg_compact")
			const timer = realTimer()
			deps.sessionFallbackTimeouts.set(sessionID, timer)
			try {
				await messages(frame("msg_compact", "compaction", [], { finish: "stop" }))
				expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(timer)
				expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
			} finally {
				helpers.clearSessionFallbackTimeout(sessionID)
				clearTimeout(timer)
			}
		})

		test("error update while compaction in-flight and awaiting preserves timeout identity", async () => {
			const deps = createMockDeps({ timeout_seconds: 3600 })
			deps.ctx.client.session.messages = mock(async () => ({ data: [] })) as any
			const helpers = createAutoRetryHelpers(deps)
			const messages = createMessageUpdateHandler(deps, helpers)
			deps.sessionCompactionInFlight.add(sessionID)
			deps.sessionAwaitingFallbackResult.add(sessionID)
			const timer = realTimer()
			deps.sessionFallbackTimeouts.set(sessionID, timer)
			try {
				await messages(frame("msg_compact", "compaction"))
				expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(timer)
				await messages(frame("msg_compact", "compaction", [], { error: { name: "APIError", message: "boom" } }))
				expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(timer)
				expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
			} finally {
				helpers.clearSessionFallbackTimeout(sessionID)
			}
		})

		test("idle during silent compaction failure keeps the existing timeout", async () => {
			const deps = createMockDeps({ timeout_seconds: 3600 })
			const helpers = createAutoRetryHelpers(deps)
			deps.sessionCompactionInFlight.add(sessionID)
			deps.sessionAwaitingFallbackResult.add(sessionID)
			deps.sessionFirstTokenReceived.set(sessionID, false)
			const timer = realTimer()
			deps.sessionFallbackTimeouts.set(sessionID, timer)
			try {
				await createEventHandler(deps, helpers).handleEvent({
					event: { type: "session.idle", properties: { sessionID } },
				})
				expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(timer)
				expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
			} finally {
				helpers.clearSessionFallbackTimeout(sessionID)
			}
		})
	})

	describe("finding 2: repeated same-ID empty updates do not replace or re-arm the timeout", () => {
		const fixture = () => {
			const deps = createMockDeps({ timeout_seconds: 3600 })
			deps.globalFallbackModels = ["openai/backup"]
			deps.ctx.client.session.messages = mock(async () => ({ data: [] })) as any
			const real = createAutoRetryHelpers(deps)
			const resolver = mock(async () => "build")
			const schedule = mock(real.scheduleSessionFallbackTimeout)
			const helpers = { ...real, resolveAgentForSessionFromContext: resolver, scheduleSessionFallbackTimeout: schedule } as unknown as AutoRetryHelpers
			const messages = createMessageUpdateHandler(deps, helpers)
			deps.sessionStates.set(sessionID, createFallbackState(primary))
			deps.sessionRequestMessages!.set(sessionID, "msg_empty")
			deps.sessionActiveRequests!.set(sessionID, "msg_empty")
			const timer = realTimer()
			deps.sessionFallbackTimeouts.set(sessionID, timer)
			return { deps, real, resolver, schedule, messages, timer }
		}

		test("second and third same-ID empty updates keep timeout identity", async () => {
			const f = fixture()
			try {
				await f.messages(frame("msg_empty"))
				await f.messages(frame("msg_empty"))
				await Bun.sleep(0)

				expect(f.deps.sessionFallbackTimeouts.get(sessionID)).toBe(f.timer)
			} finally {
				f.real.clearSessionFallbackTimeout(sessionID)
				clearTimeout(f.timer)
			}
		})

		test("same-ID empty updates do not invoke deferred resolver or schedule", async () => {
			const f = fixture()
			try {
				await f.messages(frame("msg_empty"))
				await f.messages(frame("msg_empty"))
				await Bun.sleep(0)

				expect(f.resolver).not.toHaveBeenCalled()
				expect(f.schedule).not.toHaveBeenCalled()
			} finally {
				f.real.clearSessionFallbackTimeout(sessionID)
				clearTimeout(f.timer)
			}
		})
	})

	describe("finding 3: stale overlapping handlers must not clobber a newer request", () => {
		test("old content update resolving after newer compaction request keeps new first-token flag false and model new", async () => {
			const deps = createMockDeps({ timeout_seconds: 3600 })
			deps.globalFallbackModels = ["openai/backup"]
			deps.sessionStates.set(sessionID, createFallbackState(primary))
			const helpers = createMockHelpers()
			helpers.resolveAgentForSessionFromContext = mock(async (_id, agent) => agent ?? "build") as any
			const gate = gated()
			let calls = 0
			deps.ctx.client.session.messages = mock(async () => {
				calls++
				if (calls === 1) return gate.promise
				return { data: [] }
			}) as any
			const messages = createMessageUpdateHandler(deps, helpers)

			const old = messages(frame("msg_old", "build", [{ type: "text", text: "Old content" }]))
			await Bun.sleep(0)
			await messages(frame("msg_new", "compaction", [], { model: "openai/compaction-primary" }))
			gate.release({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Old content" }] }] })
			await old
			await Bun.sleep(0)

			expect(deps.sessionFirstTokenReceived.get(sessionID) ?? false).toBe(false)
			expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("openai/compaction-primary")
		})

		test("old visible-response check resolving after newer request keeps awaiting tracking, timer, and first-token false", async () => {
			const deps = createMockDeps({ timeout_seconds: 3600 })
			deps.globalFallbackModels = ["openai/backup"]
			const helpers = createMockHelpers()
			helpers.resolveAgentForSessionFromContext = mock(async (_id, agent) => agent ?? "build") as any
			const gate = gated()
			let calls = 0
			deps.ctx.client.session.messages = mock(async () => {
				calls++
				if (calls === 2) return gate.promise
				return { data: [] }
			}) as any
			const messages = createMessageUpdateHandler(deps, helpers)
			deps.sessionAwaitingFallbackResult.add(sessionID)
			const timer = realTimer()
			deps.sessionFallbackTimeouts.set(sessionID, timer)
			try {
				const old = messages(frame("msg_old", "build", [{ type: "text", text: "Old answer" }]))
				await Bun.sleep(0)
				await messages(frame("msg_new", "build"))
				gate.release({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Old answer" }] }] })
				await old
				await Bun.sleep(0)

				expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
				expect(deps.sessionFallbackTimeouts.get(sessionID)).toBe(timer)
				expect(deps.sessionFirstTokenReceived.get(sessionID) ?? false).toBe(false)
			} finally {
				clearTimeout(timer)
				deps.sessionFallbackTimeouts.delete(sessionID)
			}
		})
	})

	describe("finding 4: new compaction request while awaiting a chat-backup result", () => {
		test("clears awaiting, moves state to compaction-primary, and arms a fresh compaction timeout", async () => {
			const deps = createMockDeps({ timeout_seconds: 3600 })
			deps.globalFallbackModels = ["openai/backup"]
			const state = createFallbackState(primary)
			state.currentModel = "openai/chat-backup"
			deps.sessionStates.set(sessionID, state)
			deps.sessionFirstTokenReceived.set(sessionID, true)
			deps.sessionAwaitingFallbackResult.add(sessionID)
			const oldTimer = realTimer()
			deps.sessionFallbackTimeouts.set(sessionID, oldTimer)

			deps.ctx.client.session.messages = mock(async () => ({ data: [] })) as any
			const real = createAutoRetryHelpers(deps)
			const schedule = mock(real.scheduleSessionFallbackTimeout)
			const helpers = {
				...real,
				resolveAgentForSessionFromContext: mock(async () => "compaction"),
				scheduleSessionFallbackTimeout: schedule,
			} as unknown as AutoRetryHelpers
			const messages = createMessageUpdateHandler(deps, helpers)
			try {
				await messages(frame("msg_compact", "compaction", [], { model: "openai/compaction-primary" }))
				await Bun.sleep(0)

				expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
				expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("openai/compaction-primary")
				expect(schedule).toHaveBeenCalledWith(sessionID, "compaction")
				expect(deps.sessionFallbackTimeouts.get(sessionID)).toBeDefined()
				expect(deps.sessionFallbackTimeouts.get(sessionID)).not.toBe(oldTimer)
			} finally {
				real.clearSessionFallbackTimeout(sessionID)
				clearTimeout(oldTimer)
			}
		})
	})
})
