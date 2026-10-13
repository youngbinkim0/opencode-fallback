// Real OpenCode v2 host regression:
//   bun run v2.integration.ts [--hung-primary] [--hung-backup] [--legacy-config] [--markdown-agent] [--foreground-task] [--notifications | --tui]
//   bun run v2.integration.ts --compaction [--hung-primary | --hung-backup | --cancel-compaction | --anthropic-backup] [--notifications]
//   bun run v2.integration.ts --background-task [--hung-primary | --background-no-error | --background-exhausted | --native-reload | --native-cancel]
//   bun run v2.integration.ts --synthetic-contract
//   bun run v2.integration.ts --streaming-tool-input
// The host and both model responses are local; no provider credentials or billable calls.
import { strict as assert } from "node:assert"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FALLBACK_CONTINUATION_PROMPT } from "./continuation-prompt"

const pluginEntry = join(import.meta.dir, "dist/index.js")
if (!existsSync(pluginEntry)) {
	throw new Error(
		`Missing ${pluginEntry}. Run bun run build, then rerun: bun run v2.integration.ts`,
	)
}

const hostBinary = Bun.env.OPENCODE_V2_BIN ?? "opencode"
const versionCheck = Bun.spawnSync([hostBinary, "--version"], { stdout: "pipe", stderr: "pipe" })
const hostVersion = versionCheck.stdout.toString().trim()
assert.equal(versionCheck.exitCode, 0, `Could not run OpenCode binary ${hostBinary}: ${versionCheck.stderr.toString()}`)
assert.match(hostVersion, /\bv?2\./, `This regression requires an OpenCode v2 host; ${hostBinary} reported ${hostVersion}`)

const hungPrimaryFlag = Bun.argv.includes("--hung-primary")
const hangingBackup = Bun.argv.includes("--hung-backup")
const legacyConfig = Bun.argv.includes("--legacy-config")
// --background-task: the parent starts the same child with native background:true (parent keeps its turn).
const backgroundTask = Bun.argv.includes("--background-task")
// --background-no-error: the child succeeds natively; no fallback runs.
const backgroundNoError = Bun.argv.includes("--background-no-error")
// --background-exhausted: primary and the only backup both fail; one final error is delivered.
const backgroundExhausted = Bun.argv.includes("--background-exhausted")
const foregroundTask = Bun.argv.includes("--foreground-task") || backgroundTask
const markdownAgent = Bun.argv.includes("--markdown-agent")
const compaction = Bun.argv.includes("--compaction")
const cancelCompaction = Bun.argv.includes("--cancel-compaction")
// --anthropic-backup serves the compaction backup over the native Anthropic Messages protocol (cross-protocol fallback).
const anthropicBackup = Bun.argv.includes("--anthropic-backup")
// --tui attaches the real terminal UI (pseudo-TTY) and asserts the fallback toast it renders.
const tuiMode = Bun.argv.includes("--tui")
const notifications = Bun.argv.includes("--notifications") || tuiMode
assert.ok(!cancelCompaction || compaction, "--cancel-compaction requires --compaction")
assert.ok(!anthropicBackup || (compaction && !hungPrimaryFlag && !cancelCompaction && !foregroundTask), "--anthropic-backup requires a plain --compaction run")
assert.ok(!compaction || !foregroundTask, "--compaction does not combine with --foreground-task")
assert.ok(!(tuiMode && (compaction || foregroundTask)), "--tui covers the primary fallback path only")
assert.ok(!(backgroundNoError && backgroundExhausted), "--background-no-error and --background-exhausted are mutually exclusive")
assert.ok(backgroundTask || !(backgroundNoError || backgroundExhausted), "--background-no-error and --background-exhausted require --background-task")
assert.ok(!backgroundTask || !(compaction || tuiMode || anthropicBackup || hangingBackup || cancelCompaction || Bun.argv.includes("--foreground-task")), "--background-task covers only the primary child fallback path")
assert.ok(!(backgroundNoError && hungPrimaryFlag), "--background-no-error does not combine with --hung-primary")
// --synthetic-contract: duplicate-ID behavior of the host synthetic API (no model turn); runs alone.
const syntheticContract = Bun.argv.includes("--synthetic-contract")
// --native-reload: runs the native `opencode reload` command against the isolated host while the child's backup is held.
const nativeReload = Bun.argv.includes("--native-reload")
// --native-cancel: the user interrupts the background child through the native interrupt API while its backup is held.
const nativeCancel = Bun.argv.includes("--native-cancel")
assert.ok(!(nativeReload && nativeCancel), "--native-reload and --native-cancel are mutually exclusive")
assert.ok(!(nativeReload || nativeCancel) || (backgroundTask && !backgroundNoError && !backgroundExhausted), "--native-reload and --native-cancel need --background-task with a held backup (not --background-no-error or --background-exhausted)")
// --streaming-tool-input: the read call's arguments stream for 3.2s with no text token under a 1s TTFT timeout; the healthy stream must not fall back.
const streamingToolInput = Bun.argv.includes("--streaming-tool-input")
assert.ok(!streamingToolInput || !(compaction || notifications || hungPrimaryFlag || hangingBackup || legacyConfig || markdownAgent || foregroundTask || backgroundTask || anthropicBackup || syntheticContract), "--streaming-tool-input runs alone")
assert.ok(!syntheticContract || !(backgroundTask || compaction || tuiMode || notifications || hungPrimaryFlag || hangingBackup || legacyConfig || markdownAgent || anthropicBackup || nativeReload || nativeCancel), "--synthetic-contract runs alone")
// In compaction mode the initial turn must succeed, so --hung-primary hangs the compaction child instead.
const hangingPrimary = hungPrimaryFlag && !compaction
const compactionHangs = compaction && (hungPrimaryFlag || cancelCompaction)

// Use the canonical path: the TUI reports its location via realpath (on macOS
// /var is a symlink to /private/var), and tui.ts only shows notifications whose
// directory matches its own location.
const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-v2-fallback-")))
const project = join(root, "project")
const progressFile = join(project, "progress.txt")
const progressMarker = "V2_COMPLETED_READ_RESULT_RETAINED"
// The answer the child is asked to give: the primary's own answer when it succeeds, else the backup's.
const childAnswer = backgroundNoError ? "PRIMARY_RESULT" : "BACKUP_RESULT"
const taskPrompt = hangingPrimary
	? `Reply with ${childAnswer}.`
	: compaction ? `Read ${progressFile}, then reply with PRIMARY_DONE.` : `Read ${progressFile}, then reply with ${childAnswer}.`
// Sent to the parent while its background child is still pending; must be answered without waiting for the child.
const parentProbePrompt = "PROBE_PARENT_AVAILABLE"
const calls: string[] = []
const requests: Array<{ model: string; body: any; anthropic?: boolean }> = []
const abortedModels: string[] = []
const notificationEvents: any[] = []
let compacting = false
let primaryAttempts = 0
let parentAttempts = 0
let runSucceeded = false
let host: ReturnType<typeof Bun.spawn> | undefined
let hostStdout: Promise<string> | undefined
let hostStderr: Promise<string> | undefined
let notificationStream: AbortController | undefined
let tui: ReturnType<typeof Bun.spawn> | undefined
let tuiOutput = ""
// Holds the background child's backup response open until the test has inspected the parent.
let releaseBackup!: () => void
const backupGate = new Promise<void>((resolve) => { releaseBackup = resolve })

const modelName = (request: any) => String(request?.model ?? "").split("/").at(-1) ?? ""
const stream = (model: string, delta: Record<string, unknown>, finishReason: string) => {
	const chunk = (value: Record<string, unknown>, finish: string | null) =>
		JSON.stringify({ id: "chatcmpl_v2_local", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: value, finish_reason: finish }] })
	return new Response(
		`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, finishReason)}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
	)
}
// Headers arrive but no event/first token does. Records client aborts so cancellation can be asserted.
const hang = (request: Request, model: string) => {
	request.signal.addEventListener("abort", () => abortedModels.push(model), { once: true })
	return new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(": waiting for primary token\n\n"))
		},
	}), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}
// Native Anthropic Messages SSE for a single text block.
const anthropicStream = (text: string) => {
	const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
	return new Response(
		event("message_start", { message: { id: "msg_v2_local", type: "message", role: "assistant", model: "backup", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }) +
			event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
			event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
			event("content_block_stop", { index: 0 }) +
			event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }) +
			event("message_stop", {}),
		{ headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
	)
}
const rateLimit = () => Response.json({
	error: {
		message: "Too Many Requests: REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit",
		type: "rate_limit_error",
	},
}, { status: 429 })
const readTool = () => stream("primary", {
	tool_calls: [{
		index: 0,
		id: "call_v2_read_progress",
		type: "function",
		function: { name: "read", arguments: JSON.stringify({ path: progressFile }) },
	}],
}, "tool_calls")
// Same read call, but its arguments stream as 16 fragments every 200ms (~3.2s) with no text token first.
const streamedReadTool = (request: Request, model: string) => {
	request.signal.addEventListener("abort", () => abortedModels.push(model), { once: true })
	const args = JSON.stringify({ path: progressFile })
	const size = Math.ceil(args.length / 16)
	const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
		`data: ${JSON.stringify({ id: "chatcmpl_v2_stream", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
	return new Response(new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder()
			// A client abort closes the stream; later writes are dropped.
			const send = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text))
				} catch {
					// Aborted by the plugin or the host.
				}
			}
			send(chunk({ role: "assistant" }, null))
			await Bun.sleep(200)
			send(chunk({ tool_calls: [{ index: 0, id: "call_v2_read_progress", type: "function", function: { name: "read", arguments: "" } }] }, null))
			for (let n = 0; n < 16; n++) {
				await Bun.sleep(200)
				send(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(n * size, (n + 1) * size) } }] }, null))
			}
			send(chunk({}, "tool_calls"))
			send("data: [DONE]\n\n")
			try {
				controller.close()
			} catch {
				// Already closed by an abort.
			}
		},
	}), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

// A first token arrives immediately (so the backup's TTFT timer is satisfied), then the stream stays open until released.
const gatedBackup = (model: string) => {
	const token = (delta: Record<string, unknown>, finishReason: string | null) => `data: ${JSON.stringify({ id: "chatcmpl_v2_local", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
	return new Response(new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder()
			controller.enqueue(encoder.encode(token({ content: childAnswer.split("_")[0] + "_" }, null)))
			await backupGate
			controller.enqueue(encoder.encode(token({ content: childAnswer.slice(childAnswer.indexOf("_") + 1) }, null) + token({}, "stop") + "data: [DONE]\n\n"))
			controller.close()
		},
	}), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}
// Parent of a background child. Turn 1 starts the child in background; turn 2 acknowledges the running result;
// a probe prompt sent while the child is pending is answered directly; the delivered outcome gets a final answer.
const parentBackgroundTurn = (body: any) => {
	const text = JSON.stringify(body.messages).replace(/\\"/g, '"')
	const delivered = /<subagent sessionID="[^"]+" state="(completed|error|cancelled)"/.exec(text)?.[1]
	if (delivered) {
		return stream("parent", { content: delivered === "completed" ? "PARENT_SAW_RESULT" : "PARENT_SAW_FAILURE" }, "stop")
	}
	if (text.includes(parentProbePrompt)) return stream("parent", { content: "PARENT_PROBE_OK" }, "stop")
	if (body.messages.some((message: any) => message.role === "tool")) {
		assert.ok(/<subagent sessionID="[^"]+" state="running"/.test(text), "Background tool result did not report a running child")
		return stream("parent", { content: "BACKGROUND_STARTED" }, "stop")
	}
	return stream("parent", { tool_calls: [{ index: 0, id: "call_v2_background_subagent", type: "function", function: {
		name: "subagent", arguments: JSON.stringify({ agent: "fallback-regression", description: "Read progress and answer", prompt: taskPrompt, background: true }),
	} }] }, "tool_calls")
}

const mock = Bun.serve({
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const body = await request.json() as any
		const model = modelName(body)
		calls.push(model)
		const anthropic = new URL(request.url).pathname.endsWith("/messages")
		requests.push({ model, body, anthropic })
		if (anthropic) {
			assert.equal(model, "backup", `Only the backup uses the Anthropic route: ${model}`)
			return anthropicStream(compacting ? "BACKUP_SUMMARY" : "BACKUP_RESULT")
		}
		if (model === "parent" && backgroundTask) return parentBackgroundTurn(body)
		if (model === "parent") {
			if (parentAttempts++ === 0) return stream(model, {
				tool_calls: [{ index: 0, id: "call_v2_subagent", type: "function", function: {
					name: "subagent", arguments: JSON.stringify({ agent: "fallback-regression", description: "Read progress and answer", prompt: taskPrompt }),
				} }],
			}, "tool_calls")
			assert.ok(JSON.stringify(body.messages.filter((message: any) => message.role === "tool")).includes("BACKUP_RESULT"),
				"Parent did not receive the recovered child result")
			return stream(model, { content: "BACKUP_RESULT" }, "stop")
		}

		if (model === "primary") {
			primaryAttempts++
			if (compaction) {
				if (compacting) return compactionHangs ? hang(request, model) : rateLimit()
				// The initial turn completes one real host tool round-trip before compaction starts.
				if (primaryAttempts === 1 && Array.isArray(body.tools) && body.tools.length > 0) return readTool()
				return stream(model, { content: "PRIMARY_DONE" }, "stop")
			}
			if (streamingToolInput) {
				// Healthy streaming: the first primary turn streams its tool call; the follow-up answers normally, with no 429.
				if (primaryAttempts === 1 && Array.isArray(body.tools) && body.tools.length > 0) return streamedReadTool(request, model)
				return stream(model, { content: "STREAM_RESULT" }, "stop")
			}
			// Complete one real host tool round-trip before the primary fails. The
			// backup request must retain both this result and the sole original task.
			if (!hangingPrimary && primaryAttempts === 1 && Array.isArray(body.tools) && body.tools.length > 0) return readTool()
			// The plugin's TTFT timeout should cancel this stream and continue on the backup.
			if (hangingPrimary) return hang(request, model)
			// Background success: the child's second primary attempt answers normally, so no fallback runs.
			if (backgroundNoError) return stream(model, { content: "PRIMARY_RESULT" }, "stop")
			return rateLimit()
		}

		assert.ok(model === "backup" || (hangingBackup && model === "backup2"), `Unexpected model request: ${JSON.stringify(body)}`)
		if (backgroundExhausted && model === "backup") return rateLimit()
		if (backgroundTask && model === "backup") return gatedBackup(model)
		if (hangingBackup && model === "backup") {
			return new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "text/event-stream" } })
		}
		return stream(model, { content: compacting ? "BACKUP_SUMMARY" : "BACKUP_RESULT" }, "stop")
	},
})

/** Polls until read() returns a truthy value. Throws with the provider call log on timeout. */
const waitUntil = async <T>(label: string, read: () => T | false | undefined | Promise<T | false | undefined>, timeoutMs = 30000): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await read()
		if (value) return value
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}; calls=${JSON.stringify(calls)}`)
		await Bun.sleep(100)
	}
}

const collectNotificationEvents = async (body: ReadableStream<Uint8Array>) => {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	try {
		for (;;) {
			const { value, done } = await reader.read()
			if (done) return
			buffer += decoder.decode(value, { stream: true })
			let end = buffer.indexOf("\n\n")
			while (end >= 0) {
				const frame = buffer.slice(0, end)
				buffer = buffer.slice(end + 2)
				for (const line of frame.split("\n")) {
					if (line.startsWith("data:")) notificationEvents.push(JSON.parse(line.slice(5).trim()))
				}
				end = buffer.indexOf("\n\n")
			}
		}
	} catch {
		// Aborted during teardown.
	}
}

// Terminal output: strip CSI/OSC/DCS and single-character escapes, then compare
// with all whitespace removed so cursor-positioned or wrapped text still matches.
const plainTerminal = (raw: string) => raw
	.replace(/\x1bP[^\x1b]*\x1b\\/g, "")
	.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
	.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
	.replace(/\x1b[@-Z\\-_]/g, "")
const squash = (text: string) => text.replace(/\s+/g, "")
// Kill only the process tree rooted at a process this harness spawned.
const killTree = (pid: number) => {
	const children = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "pipe" }).stdout.toString().split("\n").filter(Boolean).map(Number)
	for (const child of children) killTree(child)
	try { process.kill(pid, "SIGKILL") } catch {
		// Already exited.
	}
}

try {
	await mkdir(project, { recursive: true })
	await writeFile(progressFile, progressMarker)
	// Exercise the publishable tarball rather than a source checkout with
	// devDependencies. This catches missing files, exports, and runtime deps.
	const pack = Bun.spawnSync(["npm", "pack", "--json", "--pack-destination", root], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" })
	assert.equal(pack.exitCode, 0, pack.stderr.toString())
	const tarball = join(root, JSON.parse(pack.stdout.toString())[0].filename)
	const install = Bun.spawn(["npm", "install", "--prefix", project, "--ignore-scripts", "--no-audit", "--no-fund", tarball], { stdout: "pipe", stderr: "pipe" })
	const installOutput = new Response(install.stderr).text()
	assert.equal(await install.exited, 0, await installOutput)
	const pluginOptions = {
		fallback_models: ["mock-backup/backup", ...(hangingBackup ? ["mock-backup/backup2"] : [])],
		timeout_seconds: cancelCompaction ? 30 : streamingToolInput ? 1 : hungPrimaryFlag || hangingBackup ? 3 : 10,
		notify_on_fallback: notifications,
	}
	const providerModels = Object.fromEntries(["primary", "backup", "backup2", "parent"].map((id) => [id, {
		modelID: id,
		name: `Local ${id}`,
		limit: { context: 32000, output: 4096 },
		capabilities: { tools: true },
	}]))
	const config = {
		$schema: "https://opencode.ai/config.json",
		model: foregroundTask ? "mock-parent/parent" : "mock/primary",
		default_agent: foregroundTask ? "parent-regression" : "fallback-regression",
		plugins: [{ package: join(project, "node_modules", "opencode-runtime-fallback"), options: {
			...pluginOptions, ...(legacyConfig ? { fallback_models: [] } : {}),
		} }],
		providers: {
			...(foregroundTask ? { "mock-parent": {
				name: "Local parent fixture", package: "@opencode/ai/providers/openai-compatible",
				settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "local-test" }, models: { parent: providerModels.parent },
			} } : {}),
			mock: {
				name: "Local primary fixture",
				package: "@opencode/ai/providers/openai-compatible",
				settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "local-test" },
				models: { primary: providerModels.primary },
			},
			"mock-backup": anthropicBackup ? {
				// Native Anthropic provider, dummy key, same mock endpoint (/v1/messages). Output budget 1024 vs primary 4096.
				name: "Local Anthropic backup fixture",
				package: "@opencode/ai/providers/anthropic",
				settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "local-test" },
				models: { backup: { ...providerModels.backup, limit: { context: 32000, output: 1024 } } },
			} : {
				name: "Local backup fixture",
				package: "@opencode/ai/providers/openai-compatible",
				settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "local-test" },
				models: { backup: providerModels.backup, ...(hangingBackup ? { backup2: providerModels.backup2 } : {}) },
			},
		},
		[legacyConfig ? "agent" : "agents"]: {
			...(foregroundTask ? { "parent-regression": { mode: "primary", model: "mock-parent/parent", steps: 8 } } : {}),
			// Legacy v1 compaction chain: a dedicated "compaction" agent, while the parent agent's chain is distinct and empty.
			...(compaction && legacyConfig ? { compaction: { model: "mock/primary", fallback_models: ["mock-backup/backup"] } } : {}),
			...(markdownAgent ? {} : { "fallback-regression": {
				description: "Integration-test primary agent backed only by the local fixture",
				mode: foregroundTask ? "subagent" : "primary",
				model: "mock/primary",
				steps: 8,
				...(legacyConfig ? { fallback_models: compaction ? [] : pluginOptions.fallback_models } : {}),
			} }),
		},
		permissions: [{ action: "read", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "allow" }],
		share: "disabled",
	}
	await writeFile(join(project, legacyConfig ? "opencode.jsonc" : "opencode.json"),
		(legacyConfig ? "// Existing v1 per-agent fallback settings must work unchanged on v2.\n" : "") + JSON.stringify(config, null, 2))
	if (markdownAgent) {
		await mkdir(join(project, ".opencode", "agents"), { recursive: true })
		await writeFile(join(project, ".opencode", "agents", "fallback-regression.md"),
			`---\ndescription: Local Markdown agent regression\nmode: ${foregroundTask ? "subagent" : "primary"}\nmodel: mock/primary\nfallback_models: ${JSON.stringify(compaction ? [] : pluginOptions.fallback_models)}\n---\nFollow the requested task.\n`)
	}

	const portReservation = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = portReservation.port
	portReservation.stop(true)
	const home = join(root, "home")
	await mkdir(home, { recursive: true })
	await mkdir(join(root, "tmp"), { recursive: true })
	const serverPassword = "v2-local-integration-password"
	const hostEnv = {
		PATH: Bun.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: join(root, "tmp"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_STATE_HOME: join(root, "state"),
		OPENCODE_SERVER_PASSWORD: serverPassword,
	}
	host = Bun.spawn([hostBinary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: project,
		stdout: "pipe",
		stderr: "pipe",
		env: hostEnv,
	})
	hostStdout = host.stdout instanceof ReadableStream ? new Response(host.stdout).text() : Promise.resolve("")
	hostStderr = host.stderr instanceof ReadableStream ? new Response(host.stderr).text() : Promise.resolve("")

	const baseUrl = `http://127.0.0.1:${port}`
	const authHeaders = { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` }
	const api = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}/api${path}`, {
		...init,
		headers: { ...authHeaders, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	})
	let serverInfo: any
	for (let attempt = 0; attempt < 300; attempt++) {
		try {
			const response = await api("/info", { signal: AbortSignal.timeout(1000) })
			if (response.ok) {
				serverInfo = await response.json()
				break
			}
		} catch {}
		if (host.exitCode !== null) throw new Error(`OpenCode v2 server exited early with code ${host.exitCode}`)
		await Bun.sleep(100)
	}
	assert.ok(serverInfo, `OpenCode v2 server did not start at ${baseUrl}`)

	// Use the v2 public server API endpoints; the host process owns plugin
	// loading, configuration parsing, agent/tool execution, and transcript state.
	// Project plugin activation is lazy in v2: creating the session initializes
	// the project runtime before querying the plugin and agent registries.
	assert.match(String(serverInfo.version ?? ""), /^2\./, "Expected an OpenCode v2 server")
	const createdResponse = await api("/session", {
		method: "POST",
		body: JSON.stringify({ title: "OpenCode v2 fallback regression", agent: foregroundTask ? "parent-regression" : "fallback-regression", location: { directory: project } }),
		signal: AbortSignal.timeout(60000),
	})
	assert.equal(createdResponse.status, 200, await createdResponse.clone().text())
	const createdBody = await createdResponse.json() as any
	const session = createdBody.data ?? createdBody
	assert.ok(session.id, `Session create returned no session ID: ${JSON.stringify(createdBody)}`)
	if (syntheticContract) {
		// Duplicate-ID contract: the same ID returns the committed record, never a second inbox item.
		const post = (id: string, text: string) => api(`/session/${session.id}/synthetic`, {
			method: "POST",
			body: JSON.stringify({ id, text, resume: false }),
			signal: AbortSignal.timeout(10000),
		})
		const syntheticID = "msg_0123456789abcdef0123456789abcdef"
		const first = await post(syntheticID, "first payload")
		const firstBody = await first.json() as any
		const repeat = await post(syntheticID, "second payload")
		const repeatBody = await repeat.json() as any
		const other = await post("msg_ffffffffffffffffffffffffffffffff", "other payload")
		const inbox = await (await api(`/session/${session.id}/inbox`, { signal: AbortSignal.timeout(10000) })).json() as any
		const sameID = (inbox.data as any[]).filter((item) => item.id === syntheticID)
		const contract = {
			firstStatus: first.status,
			firstPayload: firstBody.data?.payload?.text,
			repeatStatus: repeat.status,
			repeatTag: repeatBody._tag ?? null,
			repeatReturnedCommitted: repeatBody.data?.payload?.text === "first payload",
			otherStatus: other.status,
			inboxCountForID: sameID.length,
			inboxPayloadForID: sameID[0]?.payload?.text,
		}
		assert.equal(first.status, 200, JSON.stringify(firstBody))
		assert.equal(repeat.status, 200, JSON.stringify(repeatBody))
		assert.equal(contract.repeatTag, null, "Duplicate ID returned a tagged error; contract changed")
		assert.ok(contract.repeatReturnedCommitted, "Duplicate ID did not return the committed record")
		assert.equal(other.status, 200, "Distinct ID rejected")
		assert.equal(contract.inboxCountForID, 1, "Duplicate ID created a second inbox item")
		assert.equal(contract.inboxPayloadForID, "first payload", "Duplicate ID overwrote the committed payload")
		console.log(JSON.stringify({ mode: "synthetic-contract", contract }, null, 2))
		host?.kill()
		await host?.exited.catch(() => {})
		await rm(root, { recursive: true, force: true })
		process.exit(0)
	}
	const locationQuery = `?${new URLSearchParams({ "location[directory]": project })}`
	const configResponse = await api(`/config${locationQuery}`)
	assert.equal(configResponse.status, 200, await configResponse.clone().text())
	const effectiveConfig = await configResponse.json() as any

	const messagesFor = async (sessionID: string): Promise<any[]> => {
		const response = await api(`/session/${sessionID}/message`, { signal: AbortSignal.timeout(10000) })
		assert.equal(response.status, 200, await response.clone().text())
		const body = await response.json() as any
		return body.data ?? body.messages ?? body
	}
	const messagesOf = () => messagesFor(session.id)
	const assistantTexts = (transcript: any[]) => transcript
		.filter((message: any) => message.type === "assistant")
		.map((message: any) => JSON.stringify(message.content ?? message.parts ?? message))
		.join("\n")
	// Native v2 delivers a background outcome as a synthetic item. It is either already in the parent transcript
	// or still queued in the parent inbox, so both are read and de-duplicated by item ID.
	const subagentDeliveries = async (childID: string): Promise<Array<{ id: string; state: string; text: string }>> => {
		const inboxResponse = await api(`/session/${session.id}/inbox`, { signal: AbortSignal.timeout(10000) })
		assert.equal(inboxResponse.status, 200, await inboxResponse.clone().text())
		const inboxBody = await inboxResponse.json() as any
		const inbox = Array.isArray(inboxBody) ? inboxBody : inboxBody.data ?? inboxBody.items ?? []
		assert.ok(Array.isArray(inbox), `Inbox did not return an array: ${JSON.stringify(inboxBody)}`)
		const found = new Map<string, { id: string; state: string; text: string }>()
		for (const item of [...await messagesOf(), ...inbox]) {
			if (item.type !== "synthetic") continue
			const text = JSON.stringify(item).replace(/\\"/g, '"')
			const match = new RegExp(`<subagent sessionID="${childID}" state="(\\w+)"`).exec(text)
			if (match) found.set(String(item.id ?? item.synthetic?.id ?? JSON.stringify(item)), { id: String(item.id ?? ""), state: match[1]!, text })
		}
		return [...found.values()]
	}
	const childSessions = async (): Promise<any[]> => {
		const response = await api(`/session?${new URLSearchParams({ parentID: session.id, "location[directory]": project })}`, { signal: AbortSignal.timeout(10000) })
		assert.equal(response.status, 200, await response.clone().text())
		const body = await response.json() as any
		return Array.isArray(body) ? body : body.items ?? body.data
	}
	const userPromptCount = (transcript: any[]) =>
		JSON.stringify(transcript.filter((message: any) => message.type === "user")).split(taskPrompt).length - 1
	const fallbackNotifications = () => notificationEvents
		.filter((event) => event.type === "rpc.opencode-fallback.notification" && event.data?.sessionID === session.id)
		.map((event) => event.data)
	const childCount = async (): Promise<number> => {
		const response = await api(`/session?${new URLSearchParams({ parentID: session.id, "location[directory]": project })}`, { signal: AbortSignal.timeout(10000) })
		assert.equal(response.status, 200, await response.clone().text())
		const body = await response.json() as any
		const items = Array.isArray(body) ? body : body.items ?? body.data
		assert.ok(Array.isArray(items), `Session list did not return an array: ${JSON.stringify(body)}`)
		return items.length
	}

	if (notifications) {
		// Subscribe before the prompt so the typed RPC notification cannot be missed.
		notificationStream = new AbortController()
		const eventResponse = await api("/event", { signal: notificationStream.signal })
		assert.ok(eventResponse.ok, `Event stream failed (${eventResponse.status})`)
		void collectNotificationEvents(eventResponse.body!)
	}

	if (tuiMode) {
		// Real terminal UI attached to the same isolated server. `script` gives the
		// TUI a pseudo-TTY; stdin is ignored so the TUI stays alive until we kill it.
		tui = Bun.spawn(["/usr/bin/script", "-q", "/dev/null", hostBinary, "--server", baseUrl, "--session", session.id, project], {
			cwd: project,
			env: { ...hostEnv, TERM: "xterm-256color", COLUMNS: "140", LINES: "40" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		})
		const tuiReader = (tui.stdout as ReadableStream<Uint8Array>).getReader()
		const tuiDecoder = new TextDecoder()
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await tuiReader.read()
					if (done) return
					tuiOutput += tuiDecoder.decode(value, { stream: true })
				}
			} catch {
				// Killed during teardown.
			}
		})()
		// Input-ready marker: the agent label rendered in the session prompt. Fail fast if the TUI exits.
		await waitUntil("TUI input prompt", () => {
			if (tui?.exitCode !== null) throw new Error(`TUI exited early (${tui?.exitCode}): ${plainTerminal(tuiOutput).slice(-800)}`)
			return squash(plainTerminal(tuiOutput)).includes("Fallback-Regression") && true
		}, 60000)
		// Let the client-side plugin finish subscribing before provoking fallback.
		await Bun.sleep(1000)
	}

	const promptPromise = api(`/session/${session.id}/prompt`, {
		method: "POST",
		body: JSON.stringify({ text: taskPrompt }),
		signal: AbortSignal.timeout(hangingPrimary ? 12000 : 60000),
	}).then((response) => ({ response }), (error) => ({ error }))
	let pluginBody: any
	let fallbackPlugin: any
	if (!hangingPrimary) for (let attempt = 0; attempt < 100; attempt++) {
		const pluginResponse = await api(`/plugin${locationQuery}`, { signal: AbortSignal.timeout(1000) })
		assert.equal(pluginResponse.status, 200, await pluginResponse.clone().text())
		pluginBody = await pluginResponse.json()
		const loadedPlugins = pluginBody.data ?? pluginBody
		fallbackPlugin = Array.isArray(loadedPlugins) ? loadedPlugins.find((plugin: any) => plugin.id === "opencode-fallback") : undefined
		if (fallbackPlugin || requests.length > 0) break
		await Bun.sleep(50)
	}
	if (!hangingPrimary && !fallbackPlugin) {
		const loadedPlugins = pluginBody?.data ?? pluginBody
		const pluginSummary = Array.isArray(loadedPlugins) ? loadedPlugins.filter((plugin: any) => plugin.source?.type !== "builtin").map((plugin: any) => ({ id: plugin.id, source: plugin.source?.type, state: plugin.state })) : loadedPlugins
		const configSummary = Array.isArray(effectiveConfig) ? effectiveConfig.filter((entry: any) => entry.type === "document").map((entry: any) => ({ path: entry.path, plugins: entry.info?.plugins, agents: Object.keys(entry.info?.agents ?? {}), providers: Object.keys(entry.info?.providers ?? {}) })) : effectiveConfig
		throw new Error(`OpenCode did not activate opencode-fallback after a real prompt request; plugins=${JSON.stringify(pluginSummary)}; config=${JSON.stringify(configSummary)}; provider calls=${JSON.stringify(requests.map(({ model, body }) => ({ model, toolNames: body.tools?.map((tool: any) => tool.function?.name ?? tool.name), messageRoles: body.messages?.map((message: any) => message.role) })))}`)
	}
	if (fallbackPlugin) assert.equal(fallbackPlugin.state?.status, "active", `Fallback plugin is not active: ${JSON.stringify(fallbackPlugin)}`)
	// The packaged ./tui export must be discovered alongside the server plugin.
	if (fallbackPlugin) assert.equal(fallbackPlugin.features?.tui, true, `Packaged TUI export not discovered: ${JSON.stringify(fallbackPlugin)}`)
	const promptResult = await promptPromise
	if ("error" in promptResult) throw new Error(`Prompt did not complete after fallback dispatch; mode=${hangingPrimary ? "hung-primary-ttft" : "primary-429"}; providerCalls=${JSON.stringify(calls)}; error=${String(promptResult.error)}`)
	const promptResponse = promptResult.response
	if (!promptResponse.ok) throw new Error(`Prompt failed (${promptResponse.status}): ${await promptResponse.text()}`)
	try {
		await promptResponse.arrayBuffer()
	} catch (error) {
		throw new Error(`Prompt response stream stayed open without completing fallback; mode=${hangingPrimary ? "hung-primary-ttft" : "primary-429"}; providerCalls=${JSON.stringify(calls)}; error=${String(error)}`)
	}

	let waitResponse: Response
	try {
		waitResponse = await api(`/experimental/session/${session.id}/wait`, {
			method: "POST",
			signal: AbortSignal.timeout(hangingPrimary ? 12000 : 60000),
		})
	} catch (error) {
		throw new Error(`Session did not become idle after the primary failure path; mode=${hangingPrimary ? "hung-primary-ttft" : "primary-429"}; providerCalls=${JSON.stringify(calls)}; error=${String(error)}`)
	}
	assert.ok(waitResponse.ok, `Session wait failed (${waitResponse.status}): ${await waitResponse.text()}`)
	if (!fallbackPlugin) {
		const pluginResponse = await api(`/plugin${locationQuery}`)
		assert.equal(pluginResponse.status, 200, await pluginResponse.clone().text())
		pluginBody = await pluginResponse.json()
		const loadedPlugins = pluginBody.data ?? pluginBody
		fallbackPlugin = Array.isArray(loadedPlugins) ? loadedPlugins.find((plugin: any) => plugin.id === "opencode-fallback") : undefined
		assert.ok(fallbackPlugin, `OpenCode did not report opencode-fallback active after the completed prompt: ${JSON.stringify(pluginBody)}`)
		assert.equal(fallbackPlugin.state?.status, "active", `Fallback plugin is not active: ${JSON.stringify(fallbackPlugin)}`)
	}

	// The project runtime is initialized by its first session execution, rather
	// than by session creation or registry reads. Inspect the native registries
	// after the prompt has exercised plugin loading and agent selection.
	const agentResponse = await api(`/agent${locationQuery}`)
	assert.equal(agentResponse.status, 200, await agentResponse.clone().text())
	const agentBody = await agentResponse.json() as any
	const agents = agentBody.data ?? agentBody
	assert.ok(Array.isArray(agents) && agents.some((agent: any) => agent.name === "fallback-regression" && agent.mode === (foregroundTask ? "subagent" : "primary")), `Native v2 agent config did not load; native /api/agent response: ${JSON.stringify(agentBody)}`)

	let mode: string
	let compactionReport: Record<string, unknown> | undefined
	let backgroundReport: Record<string, unknown> | undefined
	let serializedTranscript = ""
	let fallbackAnswered = true
	let continuationPromptSent = !compaction
	if (compaction) {
		const legacyPrefix = legacyConfig ? "legacy-" : ""
		mode = cancelCompaction ? "compaction-cancel" : hungPrimaryFlag ? "compaction-hung-primary" : hangingBackup ? "compaction-hung-backup" : anthropicBackup ? "compaction-anthropic-backup-429" : `compaction-${legacyPrefix}429`
		// The initial primary turn above succeeded without fallback. Now the
		// parent compaction runs; its only model calls are the child attempts.
		const compactionStart = requests.length
		const compactionRequests = () => requests.slice(compactionStart)
		const compactionModels = () => compactionRequests().map((request) => request.model)
		const initialTranscript = await messagesOf()
		assert.equal(userPromptCount(initialTranscript), 1, "Initial turn must store the original task exactly once")
		assert.ok(JSON.stringify(initialTranscript).includes(progressMarker), "Initial turn lost the completed read result")
		assert.equal(calls.filter((model) => model === "backup").length, 0, `Initial turn must not fall back: ${JSON.stringify(calls)}`)

		compacting = true
		const compactResponse = await api(`/session/${session.id}/compact`, {
			method: "POST",
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(10000),
		})
		assert.equal(compactResponse.status, 200, await compactResponse.clone().text())

		if (cancelCompaction) {
			await waitUntil("compaction child to reach the primary provider", () => compactionModels().includes("primary") || undefined, 15000)
			const interruptResponse = await api(`/session/${session.id}/interrupt?resume=false`, { method: "POST", signal: AbortSignal.timeout(10000) })
			assert.equal(interruptResponse.status, 200, await interruptResponse.clone().text())
			const interrupted = await interruptResponse.json() as any
			assert.equal(interrupted.interrupted, true, `Interrupt did not cancel the running compaction: ${JSON.stringify(interrupted)}`)
			await waitUntil("hung compaction provider stream to be aborted", () => abortedModels.includes("primary") || undefined, 10000)
			const idleAfterCancel = await api(`/experimental/session/${session.id}/wait`, { method: "POST", signal: AbortSignal.timeout(10000) })
			assert.ok(idleAfterCancel.ok, `Session wait failed after cancel (${idleAfterCancel.status}): ${await idleAfterCancel.text()}`)
			// Give any stray fallback time to dispatch before asserting none happened.
			await Bun.sleep(1500)
			assert.deepEqual(compactionModels(), ["primary"], `Cancelled compaction must not reach a backup: ${JSON.stringify(calls)}`)
			const cancelledTranscript = await messagesOf()
			assert.ok(!cancelledTranscript.some((message: any) => message.type === "compaction" && message.status === "completed"), "Cancelled compaction must not complete")
			assert.ok(!JSON.stringify(cancelledTranscript).includes("mock-backup"), "Cancelled compaction must not change the parent model")
			assert.equal(userPromptCount(cancelledTranscript), 1, "Cancelled compaction must not duplicate the original prompt")
			assert.ok(!JSON.stringify(requests).includes(FALLBACK_CONTINUATION_PROMPT), "Cancelled compaction must not send a continuation prompt")
			await waitUntil("ephemeral compaction children to be removed", async () => (await childCount()) === 0 || undefined, 10000)
			if (notifications) assert.equal(fallbackNotifications().length, 0, "Cancelled compaction must not emit fallback notifications")
			compactionReport = { cancelled: true, providerAborted: abortedModels.includes("primary"), compactionModels: compactionModels() }
			fallbackAnswered = false
		} else {
			const compactionMessage = await waitUntil("compaction to finish", async () =>
				(await messagesOf()).find((message: any) => message.type === "compaction" && message.status !== "running"), 30000)
			assert.equal(compactionMessage.status, "completed", `Compaction did not complete: ${JSON.stringify(compactionMessage)}`)
			assert.ok(JSON.stringify(compactionMessage).includes("BACKUP_SUMMARY"), `Compaction summary did not come from the backup: ${JSON.stringify(compactionMessage)}`)
			const expectedModels = hangingBackup ? ["primary", "backup", "backup2"] : ["primary", "backup"]
			assert.deepEqual(compactionModels(), expectedModels, `Unexpected compaction provider path: ${JSON.stringify(calls)}`)
			const first = compactionRequests()[0]
			const final = compactionRequests().at(-1)!
			if (!anthropicBackup) {
				// The summary request must replay the saved compaction request exactly, with no tools.
				assert.deepEqual(final.body.messages, first.body.messages, "Summary request must replay the saved compaction messages")
				const optionsOf = ({ messages: _messages, model: _model, ...rest }: any) => JSON.stringify(rest)
				assert.equal(optionsOf(final.body), optionsOf(first.body), "Summary request must keep the saved compaction options")
				assert.ok(final.body.messages.some((message: any) => message.role === "system"), "Summary request dropped system instructions")
				assert.ok(final.body.messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes(progressMarker)),
					"Summary request dropped the structured read tool result")
			} else {
				// Cross-protocol: the backup speaks Anthropic Messages, so compare structured content, not literal bodies.
				const body = final.body
				const bodyText = JSON.stringify(body.messages)
				assert.ok(final.anthropic, "Anthropic backup request did not use /v1/messages")
				assert.ok(JSON.stringify(body.system ?? "").includes("You are an AI agent"), "Anthropic summary request dropped system instructions")
				assert.ok(body.messages.every((message: any) => message.role === "user" || message.role === "assistant"), `Anthropic messages must use user/assistant roles only: ${bodyText.slice(0, 300)}`)
				assert.ok(bodyText.includes('"type":"tool_result"') && bodyText.includes(progressMarker), "Anthropic lowering dropped the structured read tool_result")
				// Compaction budgets: backup output limit 1024 must win over the primary's 4096; no cross-model leak.
				assert.equal(body.max_tokens, 1024, `Backup used a foreign output budget: max_tokens=${body.max_tokens}`)
				assert.equal(first.body.max_tokens ?? first.body.max_completion_tokens, 4096, "Primary output budget changed")
				assert.ok(!("reasoning_effort" in body) && !("stream_options" in body), "OpenAI-only options leaked into the Anthropic request")
				assert.ok(body.thinking === undefined || (body.thinking.type === "enabled" && body.thinking.budget_tokens < body.max_tokens), `Invalid thinking for Anthropic budget: ${JSON.stringify(body.thinking)}`)
			}
			assert.ok(!final.body.tools?.length, "Compaction child must not expose tools")
			assert.equal(JSON.stringify(final.body.messages).split(taskPrompt).length - 1, 1, "Summary request must contain the original task once")
			assert.ok(!JSON.stringify(requests).includes(FALLBACK_CONTINUATION_PROMPT), "Compaction fallback must not send a continuation prompt")
			const transcript = await messagesOf()
			assert.equal(userPromptCount(transcript), 1, "Durable transcript must store the original task exactly once")
			assert.ok(JSON.stringify(transcript).includes(progressMarker), "Durable transcript lost the completed read result")
			await waitUntil("ephemeral compaction children to be removed", async () => (await childCount()) === 0 || undefined, 10000)
			serializedTranscript = JSON.stringify(transcript)
			compactionReport = {
				cancelled: false, compactionModels: compactionModels(), summaryFromBackup: true, childrenRemoved: true,
				...(anthropicBackup ? { backupProtocol: "anthropic-messages", backupMaxTokens: final.body.max_tokens, primaryMaxTokens: first.body.max_tokens ?? first.body.max_completion_tokens } : {}),
			}
		}
	} else if (backgroundTask) {
		mode = backgroundExhausted ? "background-exhausted" : backgroundNoError ? "background-no-error" : nativeReload ? "background-native-reload" : nativeCancel ? "background-native-cancel" : hangingPrimary ? "background-hung-primary-ttft" : "background-429"
		// The held backup exists only where a fallback must still succeed; exhaustion and success need no gate.
		const gated = !backgroundNoError && !backgroundExhausted
		const expectedState = backgroundExhausted ? "error" : nativeCancel ? "cancelled" : "completed"
		const parentFinal = expectedState === "completed" ? "PARENT_SAW_RESULT" : "PARENT_SAW_FAILURE"
		let probes = 0
		let reloadReport: Record<string, unknown> | undefined
		let cancelReport: Record<string, unknown> | undefined
		// The parent must answer while the child is pending; the probe prompt is answered without waiting on the child.
		const probeParent = async (label: string) => {
			probes += 1
			const probe = await api(`/session/${session.id}/prompt`, {
				method: "POST",
				body: JSON.stringify({ text: parentProbePrompt }),
				signal: AbortSignal.timeout(30000),
			})
			if (!probe.ok) throw new Error(`Parent prompt blocked by a pending background child ${label} (${probe.status}): ${await probe.text()}`)
			await probe.arrayBuffer()
			await waitUntil(`parent answer to the probe ${label}`, async () => {
				const answers = assistantTexts(await messagesOf()).split("PARENT_PROBE_OK").length - 1
				return answers >= probes || undefined
			}, 15000)
		}
		// Parent turn 1 ends with the running acknowledgement; the prompt above returned only after that turn.
		const acknowledged = await waitUntil("parent running acknowledgement", async () => {
			const transcript = await messagesOf()
			return assistantTexts(transcript).includes("BACKGROUND_STARTED") && transcript
		}, 30000)
		const children = await childSessions()
		assert.equal(children.length, 1, `Expected exactly one background child: ${JSON.stringify(children)}`)
		const childID = children[0].id
		assert.ok(JSON.stringify(acknowledged).includes(childID), "Running tool result does not carry the child session ID")
		if (gated) {
			await waitUntil("held backup request", () => calls.includes("backup") || undefined, 30000)
			// The parent stays usable while the child waits on the held fallback response.
			await probeParent("while the child is pending")
			assert.equal((await subagentDeliveries(childID)).length, 0, "Pending child delivered an outcome before its fallback finished")
			if (nativeReload) {
				const generations = async () => (await readFile(join(home, ".config", "opencode", "opencode-fallback.log"), "utf8"))
					.split("\n").flatMap((line) => {
						const marker = "V2 fallback plugin initialized "
						const at = line.indexOf(marker)
						if (at < 0) return []
						const info = JSON.parse(line.slice(at + marker.length))
						return info.directory === project ? [info] : []
					})
				const before = (await generations()).at(-1)
				assert.ok(before?.generationID, "Runtime generation marker was not logged")
				// Native in-process reload against the isolated host, while the backup is still held.
				const reload = Bun.spawnSync([hostBinary, "reload", "--server", baseUrl], { env: hostEnv, stdout: "pipe", stderr: "pipe", cwd: project })
				reloadReport = { exitCode: reload.exitCode, stdout: reload.stdout.toString().trim().slice(0, 400), stderr: reload.stderr.toString().trim().slice(0, 400) }
				assert.equal(reload.exitCode, 0, `Native reload failed: ${JSON.stringify(reloadReport)}`)
				const after = await waitUntil("a new plugin setup generation after native reload", async () => {
					const current = (await generations()).at(-1)
					return current?.generationID !== before.generationID && current
				}, 10000)
				reloadReport.beforeGeneration = before.generationID
				reloadReport.afterGeneration = after.generationID
				reloadReport.moduleReimported = before.runtime.moduleID !== after.runtime.moduleID
				await probeParent("after reload")
				assert.equal((await subagentDeliveries(childID)).length, 0, "Child delivered an outcome during reload while its backup was held")
			}
			if (nativeCancel) {
				// The user interrupts the child natively; the outcome must arrive while the backup is still held.
				const interrupt = await api(`/session/${childID}/interrupt`, {
					method: "POST",
					body: JSON.stringify({ resume: false }),
					signal: AbortSignal.timeout(10000),
				})
				cancelReport = { interruptStatus: interrupt.status, interruptBody: (await interrupt.text()).slice(0, 200) }
				assert.ok(interrupt.ok, `Native child interrupt failed: ${JSON.stringify(cancelReport)}`)
			} else {
				releaseBackup()
			}
		}
		await waitUntil("background child outcome", async () => {
			const deliveries = await subagentDeliveries(childID)
			return deliveries.length > 0 && deliveries
		}, 30000)
		releaseBackup()
		await waitUntil("parent answer to the delivered outcome", async () => assistantTexts(await messagesOf()).includes(parentFinal) || undefined, 30000)
		// A duplicate delivery from a retry or reload would land after the first one.
		await Bun.sleep(1500)
		const deliveries = await subagentDeliveries(childID)
		assert.equal(deliveries.length, 1, `Expected exactly one background outcome, got ${deliveries.length}: ${JSON.stringify(deliveries.map((delivery) => delivery.state))}`)
		assert.equal(deliveries[0]!.state, expectedState, `Background outcome state mismatch: ${deliveries[0]!.text}; cancelReport=${JSON.stringify(cancelReport)}`)
		if (expectedState === "completed") assert.ok(deliveries[0]!.text.includes(childAnswer), "Background outcome lacks the child answer")
		if (nativeCancel) assert.ok(!deliveries[0]!.text.includes(childAnswer), "Cancelled outcome must not carry a child answer")

		// Provider accounting: the planned attempts only. The parent runs for the start, the acknowledgement, each probe, and the final outcome.
		const count = (model: string) => calls.filter((call) => call === model).length
		assert.equal(count("primary"), hangingPrimary ? 1 : 2, `Unexpected primary attempts: ${JSON.stringify(calls)}`)
		assert.equal(count("backup"), backgroundNoError ? 0 : 1, `Unexpected backup attempts: ${JSON.stringify(calls)}`)
		assert.equal(count("parent"), 3 + probes, `Unexpected parent turns: ${JSON.stringify(calls)}`)

		// Child transcript and the final child attempt: original task once; the completed read is retained when it ran.
		const childTranscript = await messagesFor(childID)
		assert.equal(userPromptCount(childTranscript), 1, "Child must store the original task exactly once")
		if (!hangingPrimary) assert.ok(JSON.stringify(childTranscript).includes(progressMarker), "Child transcript lost the completed read result")
		const attempt = requests.filter((request) => request.model === (backgroundNoError ? "primary" : "backup")).at(-1)!
		const attemptContext = JSON.stringify(attempt.body.messages)
		assert.equal(attemptContext.split(taskPrompt).length - 1, 1, "Final child attempt must contain the original task exactly once")
		if (!hangingPrimary) assert.ok(attemptContext.includes(progressMarker), "Final child attempt did not receive the completed read result")
		assert.equal(attemptContext.includes(FALLBACK_CONTINUATION_PROMPT), !backgroundNoError, "Continuation prompt presence does not match the fallback path")

		fallbackAnswered = !backgroundExhausted
		continuationPromptSent = !backgroundNoError
		backgroundReport = {
			outcome: expectedState,
			children: children.length,
			deliveries: deliveries.length,
			parentProbeWhilePending: gated,
			backupHeldUntilAssert: gated,
			probes,
			nativeReload: reloadReport,
			nativeCancel: cancelReport,
		}
	} else if (streamingToolInput) {
		mode = "streaming-tool-input"
		fallbackAnswered = false
		continuationPromptSent = false
		// Wait for the final answer, not the first idle state: an early idle must not end the check.
		let transcript: any[] = []
		const answerDeadline = Date.now() + 30000
		for (;;) {
			transcript = await messagesOf()
			const failed = transcript.some((message: any) => message.type === "assistant" && message.error)
			if (failed || assistantTexts(transcript).includes("STREAM_RESULT")) break
			if (Date.now() >= answerDeadline) throw new Error(`Streaming answer never arrived; calls=${JSON.stringify(calls)}`)
			await Bun.sleep(100)
		}
		const completedTool = (value: unknown): boolean => Array.isArray(value)
			? value.some(completedTool)
			: value !== null && typeof value === "object"
				&& ((value as any).type === "tool" && (value as any).state?.status === "completed" || Object.values(value).some(completedTool))
		assert.deepEqual(calls.filter((model) => model === "backup"), [], `Healthy streaming tool input fell back to the backup: ${JSON.stringify(calls)}`)
		assert.equal(calls.filter((model) => model === "primary").length, 2, `Original primary must be used exactly twice: ${JSON.stringify(calls)}`)
		assert.equal(transcript.some((message: any) => message.type === "assistant" && message.error), false, `Streaming assistant was interrupted: ${JSON.stringify(transcript)}`)
		assert.equal(transcript.some((message: any) => message.type === "model-switched"), false, "Healthy stream must not switch models")
		assert.ok(completedTool(transcript), `Read tool did not complete: ${JSON.stringify(transcript)}`)
		assert.ok(JSON.stringify(transcript).includes(progressMarker), "Read result was not retained in the transcript")
		assert.equal(userPromptCount(transcript), 1, "Durable transcript must store the original task exactly once")
		assert.ok(assistantTexts(transcript).includes("STREAM_RESULT"), `Final streamed answer missing: ${JSON.stringify(transcript)}`)
		serializedTranscript = JSON.stringify(transcript)
	} else {
		// wait() observes one execution. A failed execution can go idle before
		// the plugin admits its next continuation; wait for the durable answer.
		let transcript: any
		const answerDeadline = Date.now() + 15000
		while (true) {
			transcript = await messagesOf()
			if (Array.isArray(transcript) && transcript.some((message: any) => message.type === "assistant" && JSON.stringify(message.content).includes("BACKUP_RESULT"))) break
			if (Date.now() >= answerDeadline) throw new Error(`Fallback answer never arrived; calls=${JSON.stringify(calls)}`)
			await Bun.sleep(100)
		}
		serializedTranscript = JSON.stringify(transcript)
		const assistantTranscript = (Array.isArray(transcript) ? transcript : [])
			.filter((message: any) => message.type === "assistant" || message.info?.role === "assistant" || message.role === "assistant")
			.map((message: any) => JSON.stringify(message.content ?? message.parts ?? message))
			.join("\n")
		const backupRequest = requests.find((request) => request.model === "backup")
		assert.ok(backupRequest, `Backup model was never called; model calls=${JSON.stringify(calls)}`)
		const backupContext = JSON.stringify(backupRequest.body.messages)
		if (!hangingPrimary) assert.ok(backupContext.includes(progressMarker), "Backup did not receive the completed read result")
		assert.equal(backupContext.split(taskPrompt).length - 1, 1, "Backup context must contain the original task exactly once")
		assert.ok(backupContext.includes(FALLBACK_CONTINUATION_PROMPT), "Backup request omitted the fallback continuation prompt")
		const userTranscript = foregroundTask ? JSON.stringify(transcript.filter((message: any) => message.type === "user")) : serializedTranscript
		assert.equal(userTranscript.split(taskPrompt).length - 1, 1, "Durable v2 transcript must store the original task exactly once")
		if (!hangingPrimary && !foregroundTask) assert.ok(serializedTranscript.includes(progressMarker), "Durable v2 transcript lost the completed read result")
		assert.ok(assistantTranscript.includes("BACKUP_RESULT"), "Durable v2 transcript lacks the backup assistant answer")
		assert.ok(primaryAttempts >= (hangingPrimary ? 1 : 2), `Primary did not reach the expected failure path: ${JSON.stringify(calls)}`)
		assert.equal(calls.at(-1), foregroundTask ? "parent" : hangingBackup ? "backup2" : "backup", `Fallback was not the final model response: ${JSON.stringify(calls)}`)
		mode = foregroundTask ? "foreground-subagent" : markdownAgent ? "markdown-agent-429" : legacyConfig ? "legacy-config-429" : hangingPrimary ? "hung-primary-ttft" : hangingBackup ? "hung-backup-ttft" : "primary-429"
	}

	if (notifications && !cancelCompaction) {
		// Typed RPC notification must name the admitted fallback for this parent session.
		const expectedKind = compaction ? "compaction" : "primary"
		const matching = await waitUntil("fallback notification", () => {
			const found = fallbackNotifications()
			return found.length > 0 && found
		}, 5000)
		const first = matching[0]
		assert.equal(first.kind, expectedKind, `Notification kind mismatch: ${JSON.stringify(matching)}`)
		assert.equal(first.from, "mock/primary", `Notification source mismatch: ${JSON.stringify(matching)}`)
		assert.equal(first.to, "mock-backup/backup", `Notification target mismatch: ${JSON.stringify(matching)}`)
		assert.equal(first.sessionID, session.id, "Notification must reference the parent session")
		assert.equal(typeof first.id, "string", "Notification must carry a unique id")
		assert.equal(typeof first.directory, "string", "Notification must carry the project directory")
	}
	const scenarioCalls = [...calls]
	let tuiToast: { title: string; message: string; probeModelCalls: string[] } | undefined
	if (tuiMode) {
		const originalTranscript = await messagesOf()
		// Assert what the real TUI rendered, from its terminal output (not server logs).
		const hasToast = () => {
			if (tui?.exitCode !== null) throw new Error(`TUI exited before rendering the toast (${tui?.exitCode}): ${plainTerminal(tuiOutput).slice(-800)}`)
			const text = squash(plainTerminal(tuiOutput))
			return text.includes("Modelfallback") && text.includes("mock/primary->mock-backup/backup") && text
		}
		let rendered = await waitUntil("TUI fallback toast", hasToast, 5000).catch(() => false as const)
		// Client-side plugin setup may complete after the initial view is painted.
		// If the first one-shot event was missed, send the same fallback-triggering
		// task through a disposable API session in this isolated project. The TUI
		// plugin scopes notifications by directory, so this proves later real events
		// reach the running terminal without changing the primary session transcript.
		for (let attempt = 0; !rendered && attempt < 3; attempt++) {
			const retrySessionResponse = await api("/session", {
				method: "POST",
				body: JSON.stringify({ title: `TUI notification probe ${attempt + 1}`, agent: "fallback-regression", location: { directory: project } }),
				signal: AbortSignal.timeout(30000),
			})
			assert.equal(retrySessionResponse.status, 200, await retrySessionResponse.clone().text())
			const retrySessionBody = await retrySessionResponse.json() as any
			const retrySession = retrySessionBody.data ?? retrySessionBody
			assert.ok(retrySession.id, `TUI retry session returned no ID: ${JSON.stringify(retrySessionBody)}`)
			const retryPrompt = await api(`/session/${retrySession.id}/prompt`, {
				method: "POST",
				body: JSON.stringify({ text: "Reply with BACKUP_RESULT." }),
				signal: AbortSignal.timeout(60000),
			})
			if (!retryPrompt.ok) throw new Error(`TUI retry prompt failed (${retryPrompt.status}): ${await retryPrompt.text()}`)
			await retryPrompt.arrayBuffer()
			rendered = await waitUntil("TUI fallback toast after retry", hasToast, 5000).catch(() => false as const)
			const removal = await api(`/session/${retrySession.id}`, { method: "DELETE", signal: AbortSignal.timeout(10000) })
			assert.ok(removal.ok, `TUI probe cleanup failed: ${await removal.text()}`)
		}
		assert.ok(rendered, "TUI toast not rendered")
		assert.deepEqual(await messagesOf(), originalTranscript, "TUI probes must not modify the primary session transcript")
		tuiToast = { title: "Model fallback", message: "mock/primary -> mock-backup/backup", probeModelCalls: calls.slice(scenarioCalls.length) }
	}
	if (notifications) notificationStream?.abort()

	console.log(JSON.stringify({
		host: hostVersion,
		mode: tuiMode ? `${mode}+tui` : notifications ? `${mode}+notifications` : mode,
		plugin: { id: fallbackPlugin.id, status: fallbackPlugin.state.status },
		configuredAgent: "fallback-regression",
		modelCalls: scenarioCalls,
		fallbackAnswered,
		completedReadRetained: compaction ? !cancelCompaction : !hangingPrimary,
		originalPromptCopies: 1,
		continuationPromptSent,
		...(compactionReport ? { compaction: compactionReport } : {}),
		...(backgroundReport ? { background: backgroundReport } : {}),
		...(notifications ? { notifications: fallbackNotifications().map(({ kind, from, to }) => ({ kind, from, to })) } : {}),
		...(tuiToast ? { tui: { attached: true, ...tuiToast } } : {}),
	}, null, 2))
	runSucceeded = true
} finally {
	notificationStream?.abort()
	if (tui) {
		const tuiPid = tui.pid
		killTree(tuiPid)
		await tui.exited.catch(() => {})
	}
	host?.kill()
	if (host) {
		const forceKill = setTimeout(() => host?.kill("SIGKILL"), 5000)
		try {
			await host.exited
		} finally {
			clearTimeout(forceKill)
		}
		if (!runSucceeded) {
			const requestSummary = requests.map(({ model, body }) => ({
				model,
				messages: body.messages?.map((message: any) => ({
					role: message.role,
					content: typeof message.content === "string" ? message.content.slice(0, 240) : message.content,
					toolCalls: message.tool_calls?.map((tool: any) => ({ name: tool.function?.name, arguments: tool.function?.arguments })),
					toolCallID: message.tool_call_id,
				})),
				tools: body.tools?.map((tool: any) => tool.function?.name ?? tool.name),
			}))
			console.error(`v2 integration diagnostics: mode=${compaction ? "compaction" : hangingPrimary ? "hung-primary-ttft" : "primary-429"}; calls=${JSON.stringify(calls)}; aborted=${JSON.stringify(abortedModels)}; requests=${JSON.stringify(requestSummary)}`)
			if (tui) console.error(`TUI output tail:\n${plainTerminal(tuiOutput).slice(-1500)}`)
			console.error((await hostStderr) ?? "")
			console.error((await hostStdout) ?? "")
			console.error(await readFile(join(root, "home/.config/opencode/opencode-fallback.log"), "utf8").catch(() => "No plugin diagnostics"))
		}
	}
	mock.stop(true)
	await rm(root, { recursive: true, force: true })
}
