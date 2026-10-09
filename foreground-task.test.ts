import { describe, test, expect } from "bun:test"
import OpenCodeFallbackPlugin from "./index"
import type { PluginContext } from "./types"
import type { ToolContext } from "@opencode-ai/plugin"

async function fixture(models = ["databricks/other", "openai/backup"], timeout = 0) {
	const calls: any[] = []
	const aborts: string[] = []
	const pending: Array<{ resolve: (value: any) => void; reject: (error: any) => void }> = []
	const controller = new AbortController()
	let created: any
	const client = {
		app: { agents: async () => ({ data: [{ name: "explore", mode: "subagent", model: { providerID: "databricks", modelID: "primary" }, permission: [] }] }) },
		session: {
			get: async ({ path }: any) => ({ data: path.id === "parent" ? { id: "parent", permission: [{ permission: "edit", pattern: "*", action: "deny" }] } : { id: path.id, parentID: "parent" } }),
			create: async (args: any) => { created = args.body; return { data: { id: "child", parentID: "parent" } } },
			messages: async () => ({ data: [] }),
			prompt: (args: any) => { calls.push(args); return new Promise((resolve, reject) => pending.push({ resolve, reject })) },
			abort: async ({ path }: any) => { aborts.push(path.id); pending.at(-1)!.reject(new Error("Task cancelled")) },
		},
		tui: { showToast: async () => {} },
	}
	const plugin = await OpenCodeFallbackPlugin({ directory: "/tmp", client } as unknown as PluginContext, {
		fallback_models: models, timeout_seconds: timeout, notify_on_fallback: false,
	})
	const context = { sessionID: "parent", messageID: "message", agent: "build", directory: "/tmp", worktree: "/tmp", abort: controller.signal, metadata: () => {}, ask: async () => {} } satisfies ToolContext
	const args = { description: "Read source files", prompt: "Inspect the code", subagent_type: "explore" }
	const result = plugin.tool!.task.execute(args, context)
	// Attach a handler immediately so cancellation tests don't create unhandled rejections.
	result.catch(() => {})
	await until(() => calls.length === 1)
	return {
		plugin, context, args, result, calls, pending, aborts, controller,
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
