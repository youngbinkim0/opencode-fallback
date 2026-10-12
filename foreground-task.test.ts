import { describe, test, expect } from "bun:test"
import OpenCodeFallbackPlugin from "./index"
import type { PluginContext } from "./types"
import type { ToolContext } from "@opencode-ai/plugin"
import { FALLBACK_CONTINUATION_PROMPT } from "./continuation-prompt"

async function fixture(models = ["databricks/other", "openai/backup"], timeout = 0, saveInitialPrompt = true, resume = false) {
	const calls: any[] = []
	const aborts: string[] = []
	const pending: Array<{ resolve: (value: any) => void; reject: (error: any) => void }> = []
	const childMessages: any[] = resume ? [{ info: { id: "older-user", role: "user" }, parts: [{ type: "text", text: "Inspect the code" }] }] : []
	const controller = new AbortController()
	let created: any
	const client = {
		app: { agents: async () => ({ data: [{ name: "explore", mode: "subagent", model: { providerID: "databricks", modelID: "primary" }, permission: [] }] }) },
		session: {
			get: async ({ path }: any) => ({ data: path.id === "parent" ? { id: "parent", permission: [{ permission: "edit", pattern: "*", action: "deny" }] } : { id: path.id, parentID: "parent" } }),
			create: async (args: any) => { created = args.body; return { data: { id: "child", parentID: "parent" } } },
			messages: async ({ path }: any) => ({ data: path.id === "child" ? childMessages : [] }),
			prompt: (args: any) => {
				calls.push(args)
				if (saveInitialPrompt || calls.length > 1) childMessages.push({ info: { id: `user-${calls.length}`, role: "user" }, parts: args.body.parts })
				return new Promise((resolve, reject) => pending.push({ resolve, reject }))
			},
			abort: async ({ path }: any) => { aborts.push(path.id); pending.at(-1)!.reject(new Error("Task cancelled")) },
		},
		tui: { showToast: async () => {} },
	}
	const plugin = await OpenCodeFallbackPlugin({ directory: "/tmp", client } as unknown as PluginContext, {
		fallback_models: models, timeout_seconds: timeout, notify_on_fallback: false,
	})
	const context = { sessionID: "parent", messageID: "message", agent: "build", directory: "/tmp", worktree: "/tmp", abort: controller.signal, metadata: () => {}, ask: async () => {} } satisfies ToolContext
	const args = { description: "Read source files", prompt: "Inspect the code", subagent_type: "explore", ...(resume ? { task_id: "child" } : {}) }
	const rawResult = plugin.tool!.task.execute(args, context)
	const result = rawResult.then((value: string | { output: string }) => typeof value === "string" ? value : value.output)
	// Attach a handler immediately so cancellation tests don't create unhandled rejections.
	result.catch(() => {})
	await until(() => calls.length === 1)
	return {
		plugin, context, args, result, rawResult, calls, pending, aborts, controller, client,
		get created() { return created },
		retry: (message = "Too Many Requests: REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit") => plugin.event({ event: { type: "session.status", properties: { sessionID: "child", status: { type: "retry", message } } } }),
		succeed: (text = "Fallback answer") => pending.at(-1)!.resolve({ data: { info: {}, parts: [{ type: "text", text }] } }),
	}
}

async function until(condition: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (condition()) return
		await Bun.sleep(5)
	}
	throw new Error("Timed out waiting for task state")
}

describe("plugin-owned foreground task lifecycle", () => {
	test("completed task retains child metadata needed for duration and navigation", async () => {
		const f = await fixture()
		f.succeed("Original answer")
		const result = await f.rawResult
		expect(result).toEqual({
			title: f.args.description,
			output: "task_id: child\n\n<task_result>\nOriginal answer\n</task_result>",
			metadata: { parentSessionId: "parent", sessionId: "child", model: { providerID: "databricks", modelID: "primary" } },
		})
	})

	test("fallback completion retains the child link and reports the final model", async () => {
		const f = await fixture()
		await f.retry()
		await until(() => f.calls.length === 2)
		f.succeed()
		const result = await f.rawResult
		expect(result.metadata).toEqual({ parentSessionId: "parent", sessionId: "child", model: { providerID: "openai", modelID: "backup" } })
	})

	test("provider retry continues the same child without reinjecting the task", async () => {
		const f = await fixture()
		await f.retry()
		await until(() => f.calls.length === 2)
		f.succeed()
		await f.result
		expect(f.calls[0].body.parts).toEqual([{ type: "text", text: f.args.prompt }])
		expect(f.calls[1].body.parts).toEqual([{ type: "text", text: FALLBACK_CONTINUATION_PROMPT }])
		expect(f.calls.map((call) => call.path.id)).toEqual(["child", "child"])
		expect(f.calls[1].body.agent).toBe(f.args.subagent_type)
	})

	test("each further fallback uses continuation after both transport and model errors", async () => {
		const f = await fixture(["openai/one", "anthropic/two"])
		f.pending[0].reject(new Error("Service unavailable: 503"))
		await until(() => f.calls.length === 2)
		f.pending[1].resolve({ data: { info: { error: { name: "APIError", data: { statusCode: 503, message: "Service unavailable" } } }, parts: [] } })
		await until(() => f.calls.length === 3)
		f.succeed()
		await f.result
		expect(f.calls.map((call) => call.body.parts[0].text)).toEqual([
			f.args.prompt, FALLBACK_CONTINUATION_PROMPT, FALLBACK_CONTINUATION_PROMPT,
		])
		expect(f.calls.map((call) => call.path.id)).toEqual(["child", "child", "child"])
	})

	test("a transport failure before the host saves the task resends it once, then continues", async () => {
		const f = await fixture(["openai/one", "anthropic/two"], 0, false)
		f.pending[0].reject(new Error("Service unavailable: 503"))
		await until(() => f.calls.length === 2)
		f.pending[1].resolve({ data: { info: { error: { name: "APIError", data: { statusCode: 503, message: "Service unavailable" } } }, parts: [] } })
		await until(() => f.calls.length === 3)
		f.succeed()
		await f.result
		expect(f.calls.map((call) => call.body.parts[0].text)).toEqual([
			f.args.prompt, f.args.prompt, FALLBACK_CONTINUATION_PROMPT,
		])
	})

	test("resuming a task cannot mistake an older identical prompt for the unsaved new turn", async () => {
		const f = await fixture(["openai/backup"], 0, false, true)
		f.pending[0].reject(new Error("Service unavailable: 503"))
		await until(() => f.calls.length === 2)
		f.succeed()
		await f.result
		expect(f.calls.map((call) => call.body.parts[0].text)).toEqual([f.args.prompt, f.args.prompt])
		expect(f.calls.map((call) => call.path.id)).toEqual(["child", "child"])
	})

	test("parallel resumes cannot both claim a child while reading its history", async () => {
		const f = await fixture()
		f.succeed()
		await f.result
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const messages = f.client.session.messages
		let snapshots = 0
		f.client.session.messages = async (args: any) => {
			if (args.path.id === "child") { snapshots++; await gate }
			return messages(args)
		}
		const resume = { ...f.args, task_id: "child" }
		const first = f.plugin.tool!.task.execute(resume, f.context)
		const second = f.plugin.tool!.task.execute(resume, f.context)
		const results = Promise.allSettled([first, second])
		await until(() => snapshots === 2)
		release()
		await until(() => f.calls.length >= 2)
		await Bun.sleep(10)
		for (const pending of f.pending.slice(1)) pending.resolve({ data: { info: {}, parts: [{ type: "text", text: "Resumed answer" }] } })
		const settled = await results
		expect(f.calls).toHaveLength(2)
		expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1)
		const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult
		expect(rejected.reason.message).toBe("Task is already running")
	})
	test("parent promise stays pending across child cancellation and returns fallback", async () => {
		const f = await fixture()
		let settled = false
		f.result.finally(() => { settled = true })
		await f.retry()
		await until(() => f.calls.length === 2)
		expect(settled).toBe(false)
		expect(f.aborts).toEqual(["child"])
		expect(f.calls[1].body.model).toEqual({ providerID: "openai", modelID: "backup" })
		// Old child events must not start another detached replay or abort.
		await f.plugin.event({ event: { type: "session.error", properties: { sessionID: "child", error: { name: "MessageAbortedError" } } } })
		await f.plugin.event({ event: { type: "session.idle", properties: { sessionID: "child" } } })
		expect(f.aborts).toEqual(["child"])
		f.succeed()
		expect(await f.result).toBe("task_id: child\n\n<task_result>\nFallback answer\n</task_result>")
		expect(f.created.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
		expect(f.created.permission).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
	})

	test("duplicate retry notifications dispatch one fallback", async () => {
		const f = await fixture()
		await Promise.all([f.retry(), f.retry(), f.retry()])
		await until(() => f.calls.length === 2)
		expect(f.aborts).toEqual(["child"])
		f.succeed()
		await f.result
	})

	test("ordinary rate limits can use another model on the same provider", async () => {
		const f = await fixture()
		await f.retry("Too many requests")
		await until(() => f.calls.length === 2)
		expect(f.calls[1].body.model.providerID).toBe("databricks")
		f.succeed()
		await f.result
	})

	test("Haiku's named workspace quota dispatches Luna on the same provider", async () => {
		const f = await fixture(["databricks/system.ai.gpt-6-luna"])
		await f.retry("Too Many Requests: REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit for databricks-claude-haiku-5-5. Work with your Databricks account team to request a higher FMAPI rate limit tier.")
		await until(() => f.calls.length === 2)
		expect(f.aborts).toEqual(["child"])
		expect(f.calls[1].body.model).toEqual({ providerID: "databricks", modelID: "system.ai.gpt-6-luna" })
		f.succeed()
		expect(await f.result).toContain("Fallback answer")
	})

	test("fallback exhaustion is bounded and preserves provider blocking", async () => {
		const f = await fixture(["databricks/other", "openai/one", "openai/two", "anthropic/last"])
		await f.retry()
		await until(() => f.calls.length === 2)
		f.pending.at(-1)!.resolve({ data: { info: { error: { name: "APIError", data: { statusCode: 503, message: "Service unavailable" } } }, parts: [] } })
		await until(() => f.calls.length === 3)
		expect(f.calls[2].body.model.modelID).toBe("two")
		f.succeed()
		await f.result
	})

	test("no cross-provider candidate leaves original provider retry attached", async () => {
		const f = await fixture(["databricks/other"], 0.03)
		await f.retry()
		await Bun.sleep(50)
		expect(f.calls).toHaveLength(1)
		expect(f.aborts).toHaveLength(0)
		f.succeed("Original recovered")
		expect(await f.result).toContain("Original recovered")
	})

	test("exhausted fallback chain surfaces final failure without replaying indefinitely", async () => {
		const f = await fixture(["openai/backup"])
		await f.retry()
		await until(() => f.calls.length === 2)
		f.pending.at(-1)!.resolve({ data: { info: { error: { name: "APIError", data: { statusCode: 503, message: "Service unavailable" } } }, parts: [] } })
		await expect(f.result).rejects.toThrow("No available fallback models")
		expect(f.calls).toHaveLength(2)
	})

	test("user cancellation aborts child and never starts fallback", async () => {
		const f = await fixture()
		f.controller.abort()
		await expect(f.result).rejects.toThrow()
		expect(f.aborts).toEqual(["child"])
		expect(f.calls).toHaveLength(1)
	})

	test("TTFT timeout uses same owned handoff", async () => {
		const f = await fixture(["openai/backup"], 0.03)
		await until(() => f.calls.length === 2)
		f.succeed()
		expect(await f.result).toContain("Fallback answer")
		expect(f.calls[1].body.parts).toEqual([{ type: "text", text: FALLBACK_CONTINUATION_PROMPT }])
	})

	test("streaming parts cancel the TTFT timer", async () => {
		const f = await fixture(["openai/backup"], 0.03)
		await f.plugin.event({ event: { type: "message.part.updated", properties: { part: { sessionID: "child", type: "text", text: "Streaming" } } } })
		await Bun.sleep(50)
		expect(f.aborts).toHaveLength(0)
		f.succeed()
		await f.result
	})

	test("nonretryable failures propagate without fallback", async () => {
		const f = await fixture()
		f.pending.at(-1)!.resolve({ data: { info: { error: { name: "UnknownError", data: { message: "Invalid argument" } } }, parts: [] } })
		await expect(f.result).rejects.toThrow("Invalid argument")
		expect(f.calls).toHaveLength(1)
	})
})
