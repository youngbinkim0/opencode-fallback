import { describe, expect, it, mock, beforeEach } from "bun:test"
import {
	isEmptyTaskResult,
	extractChildSessionID,
	waitForChildFallbackResult,
} from "./subagent-result-sync"
import type { HookDeps, PluginContext } from "./types"

function createMockDeps(overrides?: Partial<HookDeps>): HookDeps {
	const ctx: PluginContext = {
		directory: "/test/dir",
		client: {
			session: {
				abort: mock(() => Promise.resolve()),
				messages: mock(() =>
					Promise.resolve({
						data: [],
					})
				),
				promptAsync: mock(() => Promise.resolve()),
				get: mock(() =>
					Promise.resolve({
						data: { status: "idle" },
					})
				),
			},
			tui: {
				showToast: mock(() => Promise.resolve()),
			},
		},
	}

	return {
		ctx,
		config: {
			enabled: true,
			retry_on_errors: [429, 500, 503],
			retryable_error_patterns: [],
			max_fallback_attempts: 3,
			cooldown_seconds: 60,
			timeout_seconds: 120,
			notify_on_fallback: true,
			fallback_models: [],
		},
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
		...overrides,
	}
}

describe("subagent-result-sync", () => {
	describe("isEmptyTaskResult", () => {
		it("returns true for standard empty task_result with double newline", () => {
			const output = 'task_id: ses_abc123 (for resuming...)\n\n<task_result>\n\n</task_result>'
			expect(isEmptyTaskResult(output)).toBe(true)
		})

		it("returns true for empty task_result with whitespace-only content", () => {
			const output = '<task_result>   \n  \t  \n</task_result>'
			expect(isEmptyTaskResult(output)).toBe(true)
		})

		it("returns true for empty task_result with no content at all", () => {
			const output = '<task_result></task_result>'
			expect(isEmptyTaskResult(output)).toBe(true)
		})

		it("returns false when task_result contains actual content", () => {
			const output = '<task_result>\nHere is the result of the task.\n</task_result>'
			expect(isEmptyTaskResult(output)).toBe(false)
		})

		it("returns false when no task_result tag is present", () => {
			const output = 'Some random output without tags'
			expect(isEmptyTaskResult(output)).toBe(false)
		})

		it("returns false for partial opening tag only", () => {
			const output = '<task_result>Content here but no closing tag'
			expect(isEmptyTaskResult(output)).toBe(false)
		})

		it("returns false for task_result with only a single space of content", () => {
			// A single space IS whitespace, so this should be true
			const output = '<task_result> </task_result>'
			expect(isEmptyTaskResult(output)).toBe(true)
		})

		it("returns false when content has leading/trailing whitespace around text", () => {
			const output = '<task_result>  \n  Real content here  \n  </task_result>'
			expect(isEmptyTaskResult(output)).toBe(false)
		})
	})

	describe("extractChildSessionID", () => {
		it("extracts session ID from standard task_id format", () => {
			const output = 'task_id: ses_abc123def (for resuming to continue this task if needed)\n\n<task_result>\n\n</task_result>'
			expect(extractChildSessionID(output)).toBe("ses_abc123def")
		})

		it("extracts session ID with alphanumeric characters", () => {
			const output = 'task_id: ses_2e344ad59ffeilkttxv0GzL6MF (for resuming...)'
			expect(extractChildSessionID(output)).toBe("ses_2e344ad59ffeilkttxv0GzL6MF")
		})

		it("returns null when no task_id is present", () => {
			const output = '<task_result>\n\n</task_result>'
			expect(extractChildSessionID(output)).toBeNull()
		})

		it("returns null when output is empty", () => {
			expect(extractChildSessionID("")).toBeNull()
		})

		it("returns null when task_id has no ses_ prefix", () => {
			const output = 'task_id: abc123def (for resuming...)'
			expect(extractChildSessionID(output)).toBeNull()
		})

		it("extracts first match when multiple task_ids present", () => {
			const output = 'task_id: ses_first123\ntask_id: ses_second456'
			expect(extractChildSessionID(output)).toBe("ses_first123")
		})
	})

	describe("waitForChildFallbackResult", () => {
		it("returns replacement text when child goes idle with assistant response", async () => {
			const deps = createMockDeps()
			const childID = "ses_child123"

			// Child is initially awaiting fallback
			deps.sessionAwaitingFallbackResult.add(childID)

			// After a short delay, simulate fallback completion by clearing flags
			setTimeout(() => {
				deps.sessionAwaitingFallbackResult.delete(childID)
				deps.sessionRetryInFlight.delete(childID)
			}, 80)

			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({
					data: { status: "idle" },
				})
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Here is the fallback response." }] },
					],
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 5000, pollIntervalMs: 50 })
			expect(result).toBe("Here is the fallback response.")
		})

		it("returns null after max wait when no valid assistant response appears", async () => {
			const deps = createMockDeps()
			const childID = "ses_timeout123"

			// Child stays in-flight forever
			deps.sessionRetryInFlight.add(childID)
			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({
					data: { status: "busy" },
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 200, pollIntervalMs: 50 })
			expect(result).toBeNull()
		})

		it("returns null when child goes idle but has no assistant message", async () => {
			const deps = createMockDeps()
			const childID = "ses_noresp123"

			// Child is idle immediately, no retry flags
			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({
					data: { status: "idle" },
				})
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
					],
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 300, pollIntervalMs: 50 })
			expect(result).toBeNull()
		})

		it("keeps waiting when child is actively streaming with awaiting flag set (does not enforce timeout)", async () => {
			const deps = createMockDeps()
			const childID = "ses_streaming"

			// Child has first token AND is still awaiting (real-world case:
			// streaming but message-update-handler hasn't seen final response yet)
			deps.sessionFirstTokenReceived.set(childID, true)
			deps.sessionAwaitingFallbackResult.add(childID)

			// Initial session.get returns busy (not idle yet)
			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({ data: { status: "busy" } })
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Streamed response after long generation." }] },
					],
				})
			)

			// After delay, clear awaiting and simulate session.idle event
			setTimeout(() => {
				deps.sessionAwaitingFallbackResult.delete(childID)
				// Mock session.get to return idle now
				;(deps.ctx.client.session.get as any).mockImplementation(() =>
					Promise.resolve({ data: { status: "idle" } })
				)
				// Fire the idle resolver (simulates handleSessionIdle)
				const resolvers = deps.sessionIdleResolvers.get(childID)
				if (resolvers) {
					for (const resolve of resolvers) resolve()
					deps.sessionIdleResolvers.delete(childID)
				}
			}, 250)

			// maxWaitMs is very short, but child is streaming so timeout is extended
			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 100, pollIntervalMs: 50 })
			expect(result).toBe("Streamed response after long generation.")
		})

		it("extracts response when flags clear, first token received, and session idle", async () => {
			const deps = createMockDeps()
			const childID = "ses_flags_clear"

			// Flags already clear, first token received, session idle — should extract
			deps.sessionFirstTokenReceived.set(childID, true)

			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({ data: { status: "idle" } })
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Immediate extraction." }] },
					],
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 100, pollIntervalMs: 50 })
			expect(result).toBe("Immediate extraction.")
		})

		it("keeps waiting when child is streaming AND in sessionAwaitingFallbackResult", async () => {
			const deps = createMockDeps()
			const childID = "ses_await_streaming"

			// Real-world scenario: child is both awaiting AND has first token
			deps.sessionAwaitingFallbackResult.add(childID)
			deps.sessionFirstTokenReceived.set(childID, true)

			// Initial session.get returns busy
			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({ data: { status: "busy" } })
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Response after streaming while awaiting." }] },
					],
				})
			)

			// After delay, clear awaiting and fire idle event
			setTimeout(() => {
				deps.sessionAwaitingFallbackResult.delete(childID)
				;(deps.ctx.client.session.get as any).mockImplementation(() =>
					Promise.resolve({ data: { status: "idle" } })
				)
				const resolvers = deps.sessionIdleResolvers.get(childID)
				if (resolvers) {
					for (const resolve of resolvers) resolve()
					deps.sessionIdleResolvers.delete(childID)
				}
			}, 200)

			// maxWaitMs is very short but child is streaming — timeout is extended
			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 100, pollIntervalMs: 50 })
			expect(result).toBe("Response after streaming while awaiting.")
		})

		it("times out when child is busy but NOT streaming (no first token)", async () => {
			const deps = createMockDeps()
			const childID = "ses_stuck"

			// No first token — child is busy but stuck (no progress)
			// sessionFirstTokenReceived NOT set for this child

			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({
					data: { status: "busy" },
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 200, pollIntervalMs: 50 })
			expect(result).toBeNull()
		})

		it("concatenates multiple text parts from assistant message", async () => {
			const deps = createMockDeps()
			const childID = "ses_multipart"

			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({
					data: { status: "idle" },
				})
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						{
							info: { role: "assistant" },
							parts: [
								{ type: "text", text: "Part one. " },
								{ type: "tool_use", text: "" },
								{ type: "text", text: "Part two." },
							],
						},
					],
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 1000, pollIntervalMs: 50 })
			expect(result).toBe("Part one. Part two.")
		})

		it("resets timeout when sessionLastMessageTime is updated (activity-aware)", async () => {
			const deps = createMockDeps()
			const childID = "ses_activity"

			// Session stays busy, no idle event
			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({ data: { status: "busy" } })
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Final response." }] },
					],
				})
			)

			// Simulate message activity arriving every 80ms for 300ms
			// With maxWaitMs=150ms, this should keep the timeout from firing
			const activityInterval = setInterval(() => {
				deps.sessionLastMessageTime.set(childID, Date.now())
			}, 80)

			// After 350ms, go idle
			setTimeout(() => {
				clearInterval(activityInterval)
				const resolvers = deps.sessionIdleResolvers.get(childID)
				if (resolvers) {
					for (const r of resolvers) r()
					deps.sessionIdleResolvers.delete(childID)
				}
			}, 350)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 150, pollIntervalMs: 50 })
			// Should succeed because activity kept resetting the timeout
			expect(result).toBe("Final response.")
		})

		it("returns null when session.get throws on all polls", async () => {
			const deps = createMockDeps()
			const childID = "ses_get_error"

			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.reject(new Error("API unavailable"))
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 200, pollIntervalMs: 50 })
			// Should timeout since polling never detects idle and no event fires
			expect(result).toBeNull()
		})

		it("returns null when assistant message has no text parts", async () => {
			const deps = createMockDeps()
			const childID = "ses_no_text"

			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({ data: { status: "idle" } })
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{
							info: { role: "assistant" },
							parts: [
								{ type: "tool_use", text: "" },
								{ type: "image", url: "img.png" },
							],
						},
					],
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 300, pollIntervalMs: 50 })
			expect(result).toBeNull()
		})

		it("returns null when session.messages throws during extraction", async () => {
			const deps = createMockDeps()
			const childID = "ses_msg_error"

			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({ data: { status: "idle" } })
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.reject(new Error("Messages API error"))
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 300, pollIntervalMs: 50 })
			expect(result).toBeNull()
		})

		it("handles session status as object with type field", async () => {
			const deps = createMockDeps()
			const childID = "ses_obj_status"

			// Return status as object { type: "idle" } instead of string
			;(deps.ctx.client.session.get as any).mockImplementation(() =>
				Promise.resolve({ data: { status: { type: "idle" } } })
			)
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Object status result." }] },
					],
				})
			)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 300, pollIntervalMs: 50 })
			expect(result).toBe("Object status result.")
		})

		it("detects idle via polling when session.idle event never fires", async () => {
			const deps = createMockDeps()
			const childID = "ses_poll_idle"

			// Start busy, go idle after 100ms (no session.idle event fired)
			let callCount = 0
			;(deps.ctx.client.session.get as any).mockImplementation(() => {
				callCount++
				return Promise.resolve({
					data: { status: callCount >= 3 ? "idle" : "busy" },
				})
			})
			;(deps.ctx.client.session.messages as any).mockImplementation(() =>
				Promise.resolve({
					data: [
						{ info: { role: "assistant" }, parts: [{ type: "text", text: "Polled result." }] },
					],
				})
			)

			// Keep activity going so we don't timeout before polling detects idle
			deps.sessionLastMessageTime.set(childID, Date.now())
			const keepAlive = setInterval(() => {
				deps.sessionLastMessageTime.set(childID, Date.now())
			}, 40)
			setTimeout(() => clearInterval(keepAlive), 300)

			const result = await waitForChildFallbackResult(deps, childID, { maxWaitMs: 500, pollIntervalMs: 50 })
			expect(result).toBe("Polled result.")
		})
	})
})
