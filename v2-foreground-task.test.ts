import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { installV2ForegroundTaskFallback } from "./v2-foreground-task"

function fixture(options: {
	background?: boolean
	throwNative?: boolean
	owned?: boolean
	aborted?: boolean
	fallbackResult?: string
} = {}) {
	const progress: unknown[] = []
	const calls: string[] = []
	const originalResult = {
		output: { sessionID: "child", status: "completed", output: "native result" },
		content: '<subagent sessionID="child" state="completed">\nnative result\n</subagent>',
		metadata: { sessionID: "child", status: "completed" },
	}
	const abort = new AbortController()
	if (options.aborted) abort.abort()
	let wrappedExecute: ((input: any, context: any) => Promise<unknown>) | undefined
	const native = {
		id: "subagent",
		name: "subagent",
		description: "Native subagent",
		input: {},
		output: {},
		async execute(input: any, context: any) {
			await context.progress({ sessionID: "child", status: "running" })
			if (options.throwNative) throw new Error("Native subagent failed (sessionID: child)")
			return originalResult
		},
	}
	const ctx = {
		location: { directory: "/tmp/foreground-task-test" },
		tool: {
			async transform(callback: (editor: any) => void) {
				callback({
					list: () => [native],
					update(id: string, update: (tool: any) => void) {
						if (id !== "subagent") return
						const tool = { ...native }
						update(tool)
						wrappedExecute = tool.execute
					},
				})
				return { dispose: async () => {} }
			},
		},
		session: {
			async context() { return [] },
			async interrupt(input: { sessionID: string }) {
				calls.push(`interrupt:${input.sessionID}`)
				return { interrupted: true }
			},
		},
	} as unknown as Plugin.Context
	const install = installV2ForegroundTaskFallback(ctx, {
		cancelFallback(sessionID) { calls.push(`cancel:${sessionID}`) },
		ownsFallback(sessionID) { calls.push(`owns:${sessionID}`); return options.owned ?? false },
		async waitForFallback(sessionID, signal) {
			calls.push(`wait:${sessionID}:${signal.aborted}`)
			return options.fallbackResult
		},
	})
	const context = {
		sessionID: "parent",
		agent: "build",
		messageID: "message",
		signal: abort.signal,
		async progress(value: unknown) { progress.push(value) },
	}
	return {
		calls, progress, originalResult, context,
		async execute(input: any = {}) {
			await install
			if (!wrappedExecute) throw new Error("native subagent was not wrapped")
			return wrappedExecute(input, context)
		},
	}
}

describe("v2 native foreground subagent fallback result delivery", () => {
	test("leaves successful foreground native executions untouched", async () => {
		const f = fixture()
		expect(await f.execute({})).toBe(f.originalResult)
		expect(f.calls).toEqual([])
		expect(f.progress).toEqual([{ sessionID: "child", status: "running" }])
	})

	test("recovers the native child result only when the v2 owner confirms fallback success", async () => {
		const f = fixture({ throwNative: true, owned: true, fallbackResult: "recovered answer" })
		expect(await f.execute()).toEqual({
			output: { sessionID: "child", status: "completed", output: "recovered answer" },
			content: '<subagent sessionID="child" state="completed">\nrecovered answer\n</subagent>',
			metadata: { sessionID: "child", status: "completed" },
		})
		expect(f.calls).toEqual(["owns:child", "wait:child:false"])
	})

	test("preserves native errors when the child is not owned or fallback has no result", async () => {
		for (const options of [{ owned: false }, { owned: true }]) {
			const f = fixture({ throwNative: true, ...options })
			await expect(f.execute()).rejects.toThrow("Native subagent failed")
		}
	})

	test("does not start fallback recovery after native cancellation", async () => {
		const f = fixture({ throwNative: true, owned: false, fallbackResult: "must not use", aborted: true })
		await expect(f.execute()).rejects.toThrow("Native subagent failed")
		expect(f.calls).toEqual(["owns:child"])
	})

	test("stops an owned child when the parent is cancelled instead of leaving it running", async () => {
		const f = fixture({ throwNative: true, owned: true, fallbackResult: "must not use", aborted: true })
		await expect(f.execute()).rejects.toThrow("Native subagent failed")
		// The fallback owner must be told to stop the hand-off, and the host must
		// interrupt the child; neither may wait for the fallback to finish.
		expect(f.calls).toEqual(["owns:child", "cancel:child", "interrupt:child"])
	})

	test("reads completed assistant text from the supported session context API", async () => {
		const { readV2ForegroundSubagentOutput } = await import("./v2-foreground-task")
		const ctx = {
			session: {
				async context() {
					return [
						{ type: "assistant", error: { message: "old failure" }, content: [{ type: "text", text: "old" }] },
						{ type: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "final answer" }] },
					]
				},
			},
		} as any
		expect(await readV2ForegroundSubagentOutput(ctx, "child")).toBe("final answer")
	})
})
