// Real-host regression: bun run foreground-task.integration.ts
// Uses only a local mock provider; no provider credentials or billable calls.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { strict as assert } from "node:assert"
import { tmpdir } from "node:os"

const root = await mkdtemp(join(tmpdir(), "opencode/fallback-lifecycle-"))
const calls: string[] = []
const modelScoped = Bun.argv.includes("--model-scoped")
let parentSawResult = false
const mock = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = await request.json() as any
		calls.push(body.model)
		if (body.model === "primary") return Response.json({ error: { message: modelScoped
			? "Too Many Requests: REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit for databricks-claude-haiku-5-5. Work with your Databricks account team to request a higher FMAPI rate limit tier."
			: "REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit", type: "rate_limit_error" } }, { status: 429 })
		const hasResult = body.messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("BACKUP_RESULT"))
		if (body.model === "parent" && hasResult) parentSawResult = true
		const task = body.model === "parent" && !hasResult
		const delta = task
			? { tool_calls: [{ index: 0, id: "call_task", type: "function", function: { name: "task", arguments: JSON.stringify({ description: "Mock provider task", prompt: "Reply with BACKUP_RESULT", subagent_type: "explore" }) } }] }
			: { content: body.model === "backup" ? "BACKUP_RESULT" : "PARENT_RECEIVED_BACKUP_RESULT" }
		const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({ id: "chatcmpl_mock", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
		return new Response(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, task ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
	},
})

let process: ReturnType<typeof Bun.spawn> | undefined
try {
	await mkdir(join(root, "project"))
	const wrapper = join(root, "plugin.ts")
	await writeFile(wrapper, `import plugin from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "dist/index.js")).href)}; export default ctx => plugin(ctx, { fallback_models: ${JSON.stringify(modelScoped ? [] : ["mock-backup/backup"])}, timeout_seconds: 10, notify_on_fallback: false });`)
	const provider = (models: string[]) => ({ npm: "@ai-sdk/openai-compatible", name: "Local mock", options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "local-test" }, models: Object.fromEntries(models.map((name) => [name, { name, limit: { context: 32000, output: 4096 }, toolcall: true }])) })
	const config = { $schema: "https://opencode.ai/config.json", plugin: [wrapper], model: "mock/parent", provider: { mock: provider(modelScoped ? ["parent", "primary", "backup"] : ["parent", "primary"]), "mock-backup": provider(["backup"]) }, agent: { explore: { model: "mock/primary", ...(modelScoped ? { fallback_models: ["mock/backup"] } : {}) } }, permission: "allow", share: "disabled" }
	await writeFile(join(root, "project/opencode.json"), JSON.stringify(config))
	// Reserve a local server port before spawning the host.
	const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = reservation.port
	reservation.stop(true)
	process = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: join(root, "project"), stdout: "pipe", stderr: "pipe",
		env: { ...Bun.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" },
	})
	const base = `http://127.0.0.1:${port}`
	for (let i = 0; ; i++) {
		try { if ((await fetch(`${base}/global/health`)).ok) break } catch {}
		if (i > 200) throw new Error("OpenCode server did not start")
		await Bun.sleep(100)
	}
	const created = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Fallback lifecycle integration" }) })
	assert.equal(created.status, 200, await created.clone().text())
	const session = await created.json() as any
	const response = await fetch(`${base}/session/${session.id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID: "mock", modelID: "parent" }, agent: "build", parts: [{ type: "text", text: "Delegate using task" }] }), signal: AbortSignal.timeout(60000) })
	const result = await response.json() as any
	assert.equal(response.status, 200, JSON.stringify(result))
	assert.equal(parentSawResult, true, `Parent never received fallback: ${JSON.stringify(result)}; calls=${calls}`)
	const messages = await (await fetch(`${base}/session/${session.id}/message`)).json() as any[]
	const tasks = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "task")
	assert.equal(tasks.length, 1)
	assert.equal(tasks[0].state.status, "completed", JSON.stringify(tasks[0]))
	assert.ok(tasks[0].state.output.includes("BACKUP_RESULT"))
	assert.ok(!tasks[0].state.output.includes("Task cancelled"))
	console.log(JSON.stringify({ host: "opencode", modelScoped, calls, taskStatus: tasks[0].state.status, parentSawResult }, null, 2))
} finally {
	process?.kill()
	if (process) {
		await process.exited
		const logs = process.stderr instanceof ReadableStream ? await new Response(process.stderr).text() : ""
		if (!parentSawResult) console.error(logs)
	}
	mock.stop(true)
	await rm(root, { recursive: true, force: true })
}
