// Real-host regressions: bun run foreground-task.integration.ts [--model-scoped|--markdown-global|--markdown-json|--main-session]
// Uses only a local mock provider; no provider credentials or billable calls.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { strict as assert } from "node:assert"
import { tmpdir } from "node:os"
import { FALLBACK_CONTINUATION_PROMPT } from "./continuation-prompt"

const root = await mkdtemp(join(tmpdir(), "opencode/fallback-lifecycle-"))
const calls: string[] = []
const requests: any[] = []
const mode = Bun.argv.find((arg) => ["--model-scoped", "--markdown-global", "--markdown-json", "--main-session"].includes(arg)) ?? "--default"
const mainSession = mode === "--main-session"
const modelScoped = mode === "--model-scoped"
const markdownAgent = mode === "--markdown-global" || mode === "--markdown-json"
const agentName = markdownAgent ? "custom-review" : "explore"
const expectedFallback = mode === "--markdown-json" ? "json-backup" : "backup"
// Each fallback answers with its own marker so the task output proves which model ran.
const fallbackMarker = mode === "--markdown-json" ? "JSON_BACKUP_RESULT" : "BACKUP_RESULT"
const progressFile = join(root, "project/progress.txt")
const progressMarker = "COMPLETED_READ_RESULT_RETAINED"
const taskPrompt = `Read ${progressFile}, then reply with ${fallbackMarker}.`
let parentSawResult = false
let runSucceeded = false
const mock = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = await request.json() as any
		calls.push(body.model)
		requests.push(body)
		// Make useful progress before failing the next tool-loop request. The
		// backup must receive the completed read without another full task copy.
		const read = body.model === "primary" && calls.filter((model) => model === "primary").length === 1
		// Same-provider tests use a model-scoped quota; cross-provider tests
		// exercise workspace-wide blocking without excluding their backup.
		if (body.model === "primary" && !read) return Response.json({ error: { message: modelScoped || mode === "--markdown-json"
			? "Too Many Requests: REQUEST_LIMIT_EXCEEDED: Exceeded model-scoped input tokens per minute rate limit for primary."
			: "REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit", type: "rate_limit_error" } }, { status: 429 })
		const hasResult = body.messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("<task_result>"))
		if (body.model === "parent" && hasResult) parentSawResult = true
		const task = body.model === "parent" && !hasResult
		const fallbackAnswers: Record<string, string> = { backup: "BACKUP_RESULT", "json-backup": "JSON_BACKUP_RESULT" }
		const delta = read
			? { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: progressFile }) } }] }
			: task
			? { tool_calls: [{ index: 0, id: "call_task", type: "function", function: { name: "task", arguments: JSON.stringify({ description: "Mock provider task", prompt: taskPrompt, subagent_type: agentName }) } }] }
			: { content: fallbackAnswers[body.model] ?? "PARENT_RECEIVED_RESULT" }
		const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({ id: "chatcmpl_mock", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
		return new Response(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, task || read ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
	},
})

let process: ReturnType<typeof Bun.spawn> | undefined
let stdout: Promise<string> | undefined
let stderr: Promise<string> | undefined
try {
	await mkdir(join(root, "project"))
	await writeFile(progressFile, progressMarker)
	const wrapper = join(root, "plugin.ts")
	const globalFallback = modelScoped ? [] : ["mock-backup/backup"]
	await writeFile(wrapper, `import plugin from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "dist/index.js")).href)}; export default ctx => plugin(ctx, { fallback_models: ${JSON.stringify(globalFallback)}, timeout_seconds: 10, notify_on_fallback: false });`)
	const provider = (models: string[]) => ({ npm: "@ai-sdk/openai-compatible", name: "Local mock", options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "local-test" }, models: Object.fromEntries(models.map((name) => [name, { name, limit: { context: 32000, output: 4096 }, toolcall: true }])) })
	// --markdown-json: the per-agent json-backup lives on its own provider, so the
	// global mock-backup chain and the per-agent chain are independent.
	const perAgentFallback = mode === "--model-scoped"
		? ["mock/backup"]
		: mode === "--markdown-json"
			? ["mock-json/json-backup"]
			: undefined
	const agent = markdownAgent
		? { ...(perAgentFallback ? { [agentName]: { mode: "subagent", model: "mock/primary", fallback_models: perAgentFallback } } : {}) }
		: { explore: { model: "mock/primary", ...(perAgentFallback ? { fallback_models: perAgentFallback } : {}) } }
	const providers = {
		mock: provider(["parent", "primary", ...(modelScoped ? ["backup"] : [])]),
		"mock-backup": provider(["backup"]),
		...(mode === "--markdown-json" ? { "mock-json": provider(["json-backup"]) } : {}),
	}
	const config = { $schema: "https://opencode.ai/config.json", plugin: [wrapper], model: "mock/parent", provider: providers, agent, permission: "allow", share: "disabled" }
	await writeFile(join(root, "project/opencode.json"), JSON.stringify(config))
	if (markdownAgent) {
		await mkdir(join(root, "project/.opencode/agents"), { recursive: true })
		await writeFile(join(root, `project/.opencode/agents/${agentName}.md`), `---\ndescription: Local Markdown-defined review agent\nmode: subagent\nmodel: mock/primary\n---\nReturn the requested mock result.`)
	}
	// Reserve a local server port before spawning the host.
	const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = reservation.port
	reservation.stop(true)
	process = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: join(root, "project"), stdout: "pipe", stderr: "pipe",
		// Keep host configuration and credentials out of the isolated run. All
		// model traffic is served by the local mock provider above.
		env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" },
	})
	// Drain both pipes while the host runs, so diagnostic output cannot block
	// startup or shutdown when a pipe fills.
	stdout = process.stdout instanceof ReadableStream ? new Response(process.stdout).text() : Promise.resolve("")
	stderr = process.stderr instanceof ReadableStream ? new Response(process.stderr).text() : Promise.resolve("")
	const base = `http://127.0.0.1:${port}`
	for (let i = 0; ; i++) {
		try { if ((await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
		if (i > 200) throw new Error("OpenCode server did not start")
		await Bun.sleep(100)
	}
	const hostAgents = await (await fetch(`${base}/agent`, { signal: AbortSignal.timeout(60000) })).json() as any[]
	const loadedAgent = hostAgents.find((agent) => agent.name === agentName)
	assert.ok(loadedAgent, `Host did not load ${markdownAgent ? "Markdown" : "configured"} agent ${agentName}: ${JSON.stringify(hostAgents)}`)
	assert.equal(loadedAgent.mode, "subagent", `Agent ${agentName} was not available as a subagent: ${JSON.stringify(loadedAgent)}`)
	const created = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Fallback lifecycle integration" }), signal: AbortSignal.timeout(60000) })
	assert.equal(created.status, 200, await created.clone().text())
	const session = await created.json() as any
	const response = await fetch(`${base}/session/${session.id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID: "mock", modelID: mainSession ? "primary" : "parent" }, agent: "build", parts: [{ type: "text", text: mainSession ? taskPrompt : "Delegate using task" }] }), signal: AbortSignal.timeout(60000) })
	const result = await response.json() as any
	assert.equal(response.status, 200, JSON.stringify(result))
	if (mainSession) {
		// promptAsync returns separately from the aborted original request.
		let completed = false
		for (let i = 0; i < 100 && !completed; i++) {
			const history = await (await fetch(`${base}/session/${session.id}/message`, { signal: AbortSignal.timeout(10000) })).json() as any[]
			completed = history.some((message) => message.info.role === "assistant" && message.info.modelID === expectedFallback && message.parts.some((part: any) => part.type === "text" && part.text.includes(fallbackMarker)))
			if (!completed) await Bun.sleep(100)
		}
		assert.ok(completed, `Main-session fallback never completed; calls=${calls}`)
	} else {
		assert.equal(parentSawResult, true, `Parent never received fallback: ${JSON.stringify(result)}; calls=${calls}`)
	}
	const childModelCalls = calls.filter((model) => model === "primary" || model === "backup" || model === "json-backup")
	assert.deepEqual(childModelCalls, ["primary", "primary", expectedFallback], `Unexpected child fallback precedence in ${mode}; calls=${JSON.stringify(calls)}`)
	const backupHistory = JSON.stringify(requests.find((request) => request.model === expectedFallback)?.messages)
	assert.ok(backupHistory.includes(progressMarker), "Backup did not receive the completed read result")
	assert.equal(backupHistory.split(taskPrompt).length - 1, 1, "Backup context duplicated the original task")
	assert.ok(backupHistory.includes(FALLBACK_CONTINUATION_PROMPT), "Backup context lacks the continuation")
	const messages = await (await fetch(`${base}/session/${session.id}/message`, { signal: AbortSignal.timeout(10000) })).json() as any[]
	if (mainSession) {
		const userTexts = messages.filter((message) => message.info.role === "user").flatMap((message) => message.parts.filter((part: any) => part.type === "text").map((part: any) => part.text))
		assert.deepEqual(userTexts, [taskPrompt, FALLBACK_CONTINUATION_PROMPT], "Main transcript must store the original task only once")
		console.log(JSON.stringify({ host: "opencode", mode, calls, sameSessionContinued: true, originalTaskCopies: 1, completedToolResultRetained: true }, null, 2))
		runSucceeded = true
	} else {
		const tasks = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "task")
		assert.equal(tasks.length, 1)
		assert.equal(tasks[0].state.status, "completed", JSON.stringify(tasks[0]))
		assert.ok(tasks[0].state.output.includes(fallbackMarker), `Task output lacks ${fallbackMarker}: ${tasks[0].state.output}`)
		assert.ok(!tasks[0].state.output.includes("Task cancelled"))
		const childID = /^task_id: (\S+)/.exec(tasks[0].state.output)?.[1]
		assert.equal(typeof childID, "string")
		assert.equal(tasks[0].state.metadata.sessionId, childID, "Completed task must retain the child link used by the duration display")
		assert.equal(tasks[0].state.metadata.parentSessionId, session.id)
		const childMessages = await (await fetch(`${base}/session/${childID}/message`, { signal: AbortSignal.timeout(10000) })).json() as any[]
		const userTexts = childMessages.filter((message) => message.info.role === "user").flatMap((message) => message.parts.filter((part: any) => part.type === "text").map((part: any) => part.text))
		assert.deepEqual(userTexts, [taskPrompt, FALLBACK_CONTINUATION_PROMPT], "Child transcript must store the original task only once")
		const firstUser = childMessages.find((message) => message.info.role === "user")
		const lastAssistant = childMessages.findLast((message) => message.info.role === "assistant")
		const taskDurationMs = lastAssistant?.info.time.completed - firstUser?.info.time.created
		assert.ok(Number.isFinite(taskDurationMs) && taskDurationMs > 0, "Linked child timestamps must produce a positive task duration")
		console.log(JSON.stringify({ host: "opencode", mode, markdownAgent, loadedAgent: { name: loadedAgent.name, mode: loadedAgent.mode, model: loadedAgent.model }, selectedFallback: childModelCalls[2], expectedFallback, calls, taskStatus: tasks[0].state.status, parentSawResult, originalTaskCopies: 1, completedToolResultRetained: true, taskDurationMs }, null, 2))
		runSucceeded = true
	}
} finally {
	process?.kill()
	if (process) {
		const shutdown = setTimeout(() => process?.kill("SIGKILL"), 5000)
		try { await process.exited } finally { clearTimeout(shutdown) }
		const logs = (await stderr ?? "") + (await stdout ?? "")
		if (!runSucceeded) console.error(`Integration diagnostics (${mode}): calls=${JSON.stringify(calls)}`)
		if (!runSucceeded) console.error(logs)
		if (!runSucceeded) console.error(await readFile(join(root, "home/.config/opencode/opencode-fallback.log"), "utf8").catch(() => "No plugin diagnostics"))
	}
	mock.stop(true)
	await rm(root, { recursive: true, force: true })
}
