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
					data: { status: "active" },
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
	})
})
