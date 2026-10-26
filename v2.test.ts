import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import plugin, { parseModelRef, setupV2 } from "./v2"

type ModelRef = { providerID: string; id: string; variant?: string }
type PromptArgs = { sessionID: string; text: string; resume: boolean; metadata?: Record<string, unknown> }
type Overrides = {
	agentGet: (args: { agentID: string }) => unknown
	create: (args: Record<string, unknown>) => unknown
	get: (args: { sessionID: string }) => unknown
	wait: (args: { sessionID: string }, options?: { signal?: AbortSignal }) => unknown
	interrupt: (args: { sessionID: string; resume: boolean }) => unknown
	remove: (args: { sessionID: string }) => unknown
	switchModel: (args: { sessionID: string; model: ModelRef }) => unknown
	prompt: (args: PromptArgs) => unknown
	modelList: () => unknown
}
interface EventQueue extends AsyncIterable<OpenCodeEvent> {
	push(event: OpenCodeEvent): void
	close(error?: Error): void
}

function eventQueue(signal: AbortSignal): EventQueue {
	const values: OpenCodeEvent[] = []
	const wakeups: Array<() => void> = []
	let closed = false
	let failure: Error | undefined
	const wake = () => { for (const resolve of wakeups.splice(0)) resolve() }
	const close = (error?: Error) => {
		if (closed) return
		closed = true
		failure = error
		wake()
	}
	signal.addEventListener("abort", () => close(), { once: true })
	return {
		push(event) {
			if (closed) return
			values.push(event)
			wakeups.shift()?.()
		},
		close,
		async *[Symbol.asyncIterator]() {
			while (true) {
				if (values.length) {
					yield values.shift()!
					continue
				}
				if (closed) {
					if (failure) throw failure
					return
				}
				await new Promise<void>((resolve) => wakeups.push(resolve))
			}
		},
	}
}

function gate() {
	let open!: () => void
	const promise = new Promise<void>((resolve) => { open = resolve })
	return { promise, open }
}

const files: string[] = []
const fixtures: Fixture[] = []

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.dispose()
	for (const directory of files.splice(0)) await rm(directory, { recursive: true, force: true })
})

interface Fixture {
	subagent(signal?: AbortSignal): Promise<unknown>
	agents: ReturnType<AgentEditor["list"]>
	callbacks: Map<string, (input: any) => unknown>
	registered: string[]
	disposedHooks: string[]
	interrupts: Array<{ sessionID: string; resume: boolean }>
	waits: Array<{ sessionID: string; signal?: AbortSignal }>
	switches: Array<{ sessionID: string; model: ModelRef }>
	prompts: PromptArgs[]
	gets: string[]
	activeModels: Map<string, ModelRef>
	agentLookups: string[]
	compactionChildren: Array<{ sessionID: string; model: ModelRef }>
	removedChildren: string[]
	emittedNotifications: Array<{ name: string; data: Record<string, unknown> }>
	rpcDisposals: number
	directory: string
	readonly signal: AbortSignal
	readonly subscriptions: number
	override<K extends keyof Overrides>(name: K, fn: Overrides[K] | undefined): void
	readonly modelLists: number
	emit(type: string, data: Record<string, unknown>, created?: number, location?: { directory: string; workspaceID?: string }): void
	closeEvents(error?: Error): void
	dispose(): Promise<void>
}

const KNOWN_MODELS = [
	"provider/primary", "backup/b", "backup/c", "backup/model", "backup/global", "backup/special",
	"backup/explicit", "backup/reloaded", "backup/compaction", "backup/parent",
]

function modelInfo(ref: string, enabled = true) {
	const [providerID, ...rest] = ref.split("/")
	const modelID = rest.join("/")
	return {
		id: modelID, modelID, providerID, name: modelID, enabled, status: "active",
		variants: ["balanced", "careful", "fast"].map((id) => ({ id })),
		capabilities: {}, cost: [], limit: { context: 0, output: 0 }, time: { released: 0 },
	}
}

async function fixture(
	options: Record<string, unknown> = {},
	agents: ReturnType<AgentEditor["list"]> = [],
	modelList: () => unknown = () => ({ data: KNOWN_MODELS.map((ref) => modelInfo(ref)) }),
): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "opencode-v2-test-"))
	files.push(directory)
	const callbacks = new Map<string, (input: any) => unknown>()
	const registered: string[] = []
	const disposedHooks: string[] = []
	const interrupts: Fixture["interrupts"] = []
	const waits: Fixture["waits"] = []
	const switches: Fixture["switches"] = []
	const prompts: Fixture["prompts"] = []
	const gets: string[] = []
	const activeModels = new Map<string, ModelRef>()
	const agentLookups: string[] = []
	const compactionChildren: Fixture["compactionChildren"] = []
	const compactionModels = new Map<string, ModelRef>()
	const removedChildren: string[] = []
	const emittedNotifications: Fixture["emittedNotifications"] = []
	let rpcDisposals = 0
	let modelLists = 0
	const overrides: Partial<Overrides> = { modelList }
	let queue: EventQueue | undefined
	let eventSignal!: AbortSignal
	let subscriptions = 0
	let setupCleanup: (() => Promise<void> | void) | void
	let isDisposed = false
	const nativeSubagent = {
		id: "subagent", name: "subagent",
		async execute(_input: unknown, context: any): Promise<unknown> {
			await context.progress({ sessionID: "session-v2" })
			throw new Error("Native subagent failed")
		},
	}
	const session = {
		create: async (args: Record<string, unknown>) => {
			const model = args.model as ModelRef | undefined
			if (args.metadata && (args.metadata as Record<string, unknown>).compaction === true && model) {
				const id = `compaction-child-${compactionChildren.length + 1}`
				compactionChildren.push({ sessionID: id, model })
				compactionModels.set(id, model)
				const result = await overrides.create?.(args)
				return result ?? { id }
			}
			throw new Error("Unexpected unowned session.create in setupV2 fixture")
		},
		context: async () => [{ type: "assistant", content: [{ type: "text", text: "RECOVERED_CHILD_RESULT" }] }],
		hook: async (name: string, callback: (input: any) => unknown) => {
			registered.push(name)
			const previous = callbacks.get(name)
			callbacks.set(name, previous ? (input) => {
				const result = previous(input)
				return result && typeof (result as Promise<unknown>).then === "function"
					? Promise.resolve(result).then(() => callback(input))
					: callback(input)
			} : callback)
			return { dispose: async () => { disposedHooks.push(name) } }
		},
		get: async (args: { sessionID: string }) => {
			gets.push(args.sessionID)
			if (overrides.get) return overrides.get(args)
			return { model: activeModels.get(args.sessionID) }
		},
		wait: async (args: { sessionID: string }, opts?: { signal?: AbortSignal }) => {
			waits.push({ sessionID: args.sessionID, signal: opts?.signal })
			await overrides.wait?.(args, opts)
		},
		interrupt: async (args: { sessionID: string; resume: boolean }) => {
			interrupts.push(args)
			return overrides.interrupt ? await overrides.interrupt(args) : { interrupted: true }
		},
		switchModel: async (args: { sessionID: string; model: ModelRef }) => {
			switches.push(args)
			await overrides.switchModel?.(args)
			activeModels.set(args.sessionID, args.model)
		},
		prompt: async (args: PromptArgs) => {
			prompts.push(args)
			if (compactionModels.has(args.sessionID)) {
				const model = compactionModels.get(args.sessionID)!
				const context = {
					sessionID: args.sessionID,
					agent: "compaction",
					model,
					system: [{ type: "text", text: "child system" }],
					messages: [{ type: "user", text: "child message" }],
					options: {},
					tools: { bash: {} },
				}
				await callbacks.get("context")?.(context)
			}
			await overrides.prompt?.(args)
		},
		remove: async (args: { sessionID: string }) => {
			if (compactionModels.has(args.sessionID)) {
				removedChildren.push(args.sessionID)
				compactionModels.delete(args.sessionID)
			}
			await overrides.remove?.(args)
		},
	}
	const ctx = {
		location: { directory, workspaceID: "test-workspace" },
		options,
		tool: { transform: async (callback: (editor: any) => void) => {
			callback({ list: () => [nativeSubagent], update: (_id: string, update: (tool: any) => void) => update(nativeSubagent) })
			return { dispose: async () => {} }
		} },
		model: {
			list: async () => {
				modelLists++
				return overrides.modelList!()
			},
		},
		agent: {
			get: async ({ agentID }: { agentID: string }) => {
				agentLookups.push(agentID)
				return overrides.agentGet ? overrides.agentGet({ agentID }) : ({ data: agents.find((agent) => String(agent.id) === agentID) ?? { id: agentID, request: {} } })
			},
		},
		rpc: {
			register: async () => ({
				events: { emit: async (name: string, data: Record<string, unknown>) => { emittedNotifications.push({ name, data }) } },
				dispose: async () => { rpcDisposals++ },
			}),
		},
		session,
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => {
				subscriptions++
				eventSignal = signal
				queue = eventQueue(signal)
				return queue
			},
		},
	} as unknown as Plugin.Context
	setupCleanup = await setupV2(ctx)
	const value: Fixture = {
		subagent: (signal = new AbortController().signal) => nativeSubagent.execute({}, { signal, progress: async () => {} }),
		callbacks, registered, disposedHooks, interrupts, waits, switches, prompts, gets, activeModels, agentLookups,
		compactionChildren, removedChildren, emittedNotifications, get rpcDisposals() { return rpcDisposals }, directory, agents,
		get signal() { return eventSignal },
		get subscriptions() { return subscriptions },
		get modelLists() { return modelLists },
		override(name, fn) { overrides[name] = fn as any },
		emit(type, data, created = Date.now(), location) { queue?.push({ type, data, created, ...(location ? { location } : {}) } as unknown as OpenCodeEvent) },
		closeEvents(error) { queue?.close(error) },
		async dispose() {
			if (isDisposed) return
			isDisposed = true
			await setupCleanup?.()
		},
	}
	fixtures.push(value)
	return value
}

const original: ModelRef = { providerID: "provider", id: "primary" }
const backupB: ModelRef = { providerID: "backup", id: "b" }
const sessionID = "session-v2"
const retryableError = { name: "APIError", message: "429 Too Many Requests", status: 429 }
const serverError = { name: "APIError", message: "500 Internal Server Error", status: 500 }
const badRequest = { name: "APIError", message: "400 Bad request: invalid schema", status: 400 }

async function invokeContext(f: Fixture, id = sessionID, agent = "build", model = original) {
	f.activeModels.set(id, model)
	await f.callbacks.get("context")!({ sessionID: id, agent, model } as SessionHooks["context"])
}

function compactionEvent(id = sessionID, agent = "build", model = original) {
	return {
		sessionID: id,
		agent,
		model,
		system: [{ type: "text", text: "system" }],
		messages: [{ type: "user", id: "user-1", text: "compact me" }],
		options: {},
		kind: "compaction",
	} as unknown as SessionHooks["compaction"]
}

function modelRequest(f: Fixture, kind: string, id = sessionID, agent = "build", model = original) {
	f.callbacks.get("model.request")!({ sessionID: id, agent, model, kind, headers: {} })
}

function stepStarted(f: Fixture, id = sessionID, messageID = "assistant-1", agent = "build", model = original) {
	f.emit("session.step.started", { sessionID: id, assistantMessageID: messageID, agent, model })
}

function failure(f: Fixture, id = sessionID, messageID = "assistant-1", error: unknown = retryableError) {
	f.emit("session.step.failed", { sessionID: id, assistantMessageID: messageID, error })
	f.emit("session.execution.failed", { sessionID: id, error })
}

function userPrompt(id = sessionID, metadata?: Record<string, unknown>) {
	return { sessionID: id, messageID: `user-${Date.now()}`, prompt: { parts: [] }, delivery: "async", metadata } as unknown as SessionHooks["prompt"]
}

async function settle(ms = 40) {
	await Bun.sleep(ms)
}

async function until(predicate: () => boolean, description: string, timeout = 1200) {
	const deadline = Date.now() + timeout
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
		await Bun.sleep(5)
	}
}

function retryEvent(agent = "build", model = original, id = sessionID) {
	return {
		sessionID: id,
		agent,
		model,
		error: retryableError,
		attempt: 1,
		decision: { retry: true as const, delay: 25 },
	} as SessionHooks["retry"]
}

describe("setupV2", () => {
	test("exports the v2 setup and model parser through the default plugin definition", () => {
		expect(plugin.id).toBe("opencode-fallback")
		expect(plugin.setup).toBe(setupV2)
		expect(typeof plugin.server).toBe("function")
		expect(parseModelRef("provider/model#fast")).toEqual({ providerID: "provider", id: "model", variant: "fast" })
		expect(parseModelRef("provider/model")).toEqual({ providerID: "provider", id: "model" })
		expect(() => parseModelRef("invalid")).toThrow("Invalid fallback model")
	})

	test("does not register hooks or subscribe when disabled", async () => {
		const f = await fixture({ enabled: false, fallback_models: ["backup/model"] })
		expect(f.registered).toEqual([])
		expect(f.callbacks.size).toBe(0)
		expect(f.subscriptions).toBe(0)
		expect(f.waits).toEqual([])
	})

	test("turns off provider retry and dispatches once through step.failed then execution.failed", async () => {
		const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(10)
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		failure(f)
		f.emit("session.execution.failed", { sessionID, assistantMessageID: "assistant-1", error: retryableError })
		await until(() => f.prompts.length === 1, "fallback continuation prompt")
		expect(f.waits).toHaveLength(1)
		expect(f.switches).toEqual([{ sessionID, model: { providerID: "backup", id: "model" } }])
		expect(f.prompts[0].resume).toBe(true)
	})

	test("leaves a retry decision untouched when there is no fallback candidate", async () => {
		const f = await fixture({ fallback_models: [], timeout_seconds: 0 })
		await invokeContext(f)
		const retry = retryEvent()
		const decision = retry.decision
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toBe(decision)
		expect(f.switches).toEqual([])
	})

	test("starts TTFT at context and interrupts before falling back if no step event arrives", async () => {
		const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0.03 })
		await invokeContext(f)
		await until(() => f.prompts.length === 1, "TTFT fallback without step events")
		expect(f.interrupts).toEqual([{ sessionID, resume: false }])
		expect(f.switches[0]?.model).toEqual({ providerID: "backup", id: "model" })
	})

	test("stops native retry when an owned fallback chain is exhausted", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "fallback admission")
		await invokeContext(f, sessionID, "build", backupB)
		const retry = retryEvent("build", backupB)
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		failure(f, sessionID, "backup-assistant")
		await settle()
		expect(f.prompts).toHaveLength(1)
		f.override("get", () => ({ model: backupB, outcome: "failed", time: { idle: Date.now() } }))
		await expect(f.subagent()).rejects.toThrow("Native subagent failed")
	})

	test("a queued user turn does not inherit exhaustion retry suppression from a successful recovery", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], max_fallback_attempts: 1, timeout_seconds: 0 })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "fallback admission")
		await invokeContext(f, sessionID, "build", backupB)
		await f.callbacks.get("prompt")!(userPrompt())
		f.emit("session.execution.succeeded", { sessionID })
		await settle()
		await invokeContext(f, sessionID, "build", backupB)
		const retry = retryEvent("build", backupB)
		const decision = retry.decision
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toBe(decision)
	})

	test("exhausted owned chain preserves native retry for a non-retryable plugin error", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "fallback admission")
		await invokeContext(f, sessionID, "build", backupB)
		const retry = { ...retryEvent("build", backupB), error: badRequest }
		const decision = retry.decision
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toBe(decision)
	})

	for (const type of ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta"]) {
		test(`${type} cancels the first-token timer`, async () => {
			const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0.05 })
			await invokeContext(f)
			stepStarted(f)
			await settle(5)
			f.emit(type, { sessionID, assistantMessageID: "assistant-1", delta: "first frame" })
			await settle(120)
			expect(f.interrupts).toEqual([])
			expect(f.switches).toEqual([])
			expect(f.prompts).toEqual([])
		})
	}

	for (const type of ["session.text.started", "session.reasoning.started", "session.tool.input.started"]) {
		test(`${type} cancels TTFT even when the host does not publish input deltas`, async () => {
			const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0.05 })
			await invokeContext(f)
			stepStarted(f)
			await settle(5)
			f.emit(type, { sessionID, assistantMessageID: "assistant-1", ordinal: 0, id: "call-stream", name: "read" })
			await settle(120)
			expect(f.interrupts).toEqual([])
			expect(f.switches).toEqual([])
			expect(f.prompts).toEqual([])
		})

		test(`stale ${type} cannot cancel the current request's TTFT`, async () => {
			const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0.05 })
			await invokeContext(f)
			stepStarted(f, sessionID, "assistant-current")
			await settle(5)
			f.emit(type, { sessionID, assistantMessageID: "assistant-previous", ordinal: 0, id: "call-old", name: "read" })
			await until(() => f.prompts.length === 1, "fallback after stale start event")
			expect(f.interrupts).toEqual([{ sessionID, resume: false }])
		})
	}

	test("a new model request has its own TTFT after streamed tool input satisfied the previous request", async () => {
		const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0.05 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		f.emit("session.tool.input.started", { sessionID, assistantMessageID: "assistant-1", id: "call-stream", name: "read" })
		await settle(80)
		expect(f.interrupts).toEqual([])
		await invokeContext(f)
		stepStarted(f, sessionID, "assistant-next")
		await until(() => f.prompts.length === 1, "TTFT for next request")
		expect(f.interrupts).toEqual([{ sessionID, resume: false }])
	})

	test("ignores a stale previous-message delta when deciding whether the new request produced a token", async () => {
		const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0.05 })
		await invokeContext(f)
		stepStarted(f, sessionID, "assistant-current")
		await settle(5)
		f.emit("session.text.delta", { sessionID, assistantMessageID: "assistant-previous", delta: "stale" })
		await until(() => f.prompts.length === 1, "fallback after stale delta")
		expect(f.interrupts).toEqual([{ sessionID, resume: false }])
		expect(f.switches).toHaveLength(1)
	})

	test("manual interruption while wait is pending prevents fallback prompt admission", async () => {
		const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0 })
		const release = gate()
		f.override("wait", () => release.promise)
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		failure(f)
		await until(() => f.waits.length === 1, "session.wait")
		f.emit("session.execution.interrupted", { sessionID })
		await settle(10)
		release.open()
		await settle(20)
		expect(f.prompts).toEqual([])
		expect(f.switches).toEqual([])
	})

	test("cleanup aborts the event stream, clears TTFT, and disposes every registered hook", async () => {
		const f = await fixture({ fallback_models: ["backup/model"], timeout_seconds: 0.03 })
		await invokeContext(f)
		await f.dispose()
		expect(f.signal.aborted).toBe(true)
		expect(f.disposedHooks.sort()).toEqual(["compaction", "context", "context", "http.request", "model.request", "prompt", "retry", "retry"])
		await settle(100)
		expect(f.interrupts).toEqual([])
		expect(f.switches).toEqual([])
		expect(f.prompts).toEqual([])
	})

	test("uses agent-specific chains and preserves variants in fallback model references", async () => {
		const f = await fixture({
			fallback_models: ["backup/global"],
			agents: { writer: { fallback_models: ["backup/special#balanced"] } },
			timeout_seconds: 0,
		})
		const writerModel = { providerID: "provider", id: "primary", variant: "careful" }
		await invokeContext(f, "writer-session", "writer", writerModel)
		stepStarted(f, "writer-session", "writer-message", "writer", writerModel)
		await settle(5)
		f.callbacks.get("retry")!({ ...retryEvent("writer", writerModel), sessionID: "writer-session" })
		f.emit("session.step.failed", { sessionID: "writer-session", assistantMessageID: "writer-message", error: retryableError })
		f.emit("session.execution.failed", { sessionID: "writer-session", assistantMessageID: "writer-message", error: retryableError })
		await until(() => f.prompts.length === 1, "writer fallback")
		expect(f.switches[0]?.model).toEqual({ providerID: "backup", id: "special", variant: "balanced" })

		await invokeContext(f, "analyst-session", "analyst", original)
		stepStarted(f, "analyst-session", "analyst-message", "analyst", original)
		await settle(5)
		failure(f, "analyst-session", "analyst-message")
		await until(() => f.prompts.length === 2, "global fallback for other agent")
		expect(f.switches[1]?.model).toEqual({ providerID: "backup", id: "global" })
	})

	test("recovers to the original model on a later user prompt after cooldown expires", async () => {
		const f = await fixture({ fallback_models: ["backup/model"], cooldown_seconds: 0.03, timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		failure(f)
		await until(() => f.prompts.length === 1, "initial fallback")
		const onPrompt = f.callbacks.get("prompt")!
		await onPrompt(userPrompt())
		expect(f.switches).toHaveLength(1)
		await settle(45)
		await onPrompt(userPrompt())
		expect(f.switches).toHaveLength(2)
		expect(f.switches[1]?.model).toEqual(original)
	})
})

describe("setupV2 legacy OpenCode agent configuration", () => {
	const agent = (fallback_models: unknown, model = original) => ({
		id: "build", name: "Build", model, request: { body: { fallback_models } },
	}) as ReturnType<AgentEditor["list"]>[number]

	test("uses legacy fallback_models from the host-resolved opencode.jsonc agent", async () => {
		const configured = agent(["backup/b"])
		const f = await fixture({ timeout_seconds: 0 }, [configured])
		await invokeContext(f)
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		failure(f)
		await until(() => f.prompts.length === 1, "legacy agent fallback")
		expect(f.switches[0]?.model).toEqual(backupB)
	})

	test("recovers the configured primary after starting on a manually selected backup", async () => {
		const f = await fixture({ timeout_seconds: 0 }, [agent("backup/b")])
		await invokeContext(f, sessionID, "build", backupB)
		failure(f)
		await until(() => f.prompts.length === 1, "configured primary recovery")
		expect(f.switches[0]?.model).toEqual(original)
	})

	test("explicit plugin agent options override the legacy chain", async () => {
		const f = await fixture({ timeout_seconds: 0, agents: { build: { fallback_models: ["backup/explicit"] } } }, [agent(["backup/b"])])
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "explicit agent fallback")
		expect(f.switches[0]?.model.id).toBe("explicit")
	})

	test("an empty legacy chain uses the global chain without opting into primary recovery", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/global"] }, [agent([])])
		await invokeContext(f, sessionID, "build", backupB)
		failure(f)
		await until(() => f.prompts.length === 1, "global fallback")
		expect(f.switches[0]?.model.id).toBe("global")
	})

	test("agent reload refreshes legacy chains", async () => {
		const configured = agent(["backup/b"])
		const f = await fixture({ timeout_seconds: 0 }, [configured])
		configured.request.body = { fallback_models: ["backup/reloaded"] }
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "reloaded agent fallback")
		expect(f.switches[0]?.model.id).toBe("reloaded")
	})

	test("user cancellation during agent lookup cannot revive the request", async () => {
		const f = await fixture({ timeout_seconds: 0.03, fallback_models: ["backup/b"] })
		const lookup = gate()
		f.override("agentGet", async () => { await lookup.promise; return { data: agent(["backup/b"]) } })
		const request = invokeContext(f)
		await settle(5)
		f.emit("session.execution.interrupted", { sessionID })
		await settle(5)
		lookup.open()
		await request
		await settle(70)
		expect(f.prompts).toEqual([])
	})

	test("unloading during agent lookup cannot start a late TTFT timer", async () => {
		const f = await fixture({ timeout_seconds: 0.03, fallback_models: ["backup/b"] })
		const lookup = gate()
		f.override("agentGet", async () => { await lookup.promise; return { data: agent(["backup/b"]) } })
		const request = invokeContext(f)
		await f.dispose()
		lookup.open()
		await request
		await settle(70)
		expect(f.interrupts).toEqual([])
		expect(f.prompts).toEqual([])
	})

	test("unavailable agent metadata preserves an explicit plugin chain", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		f.override("agentGet", () => { throw new Error("agent metadata unavailable") })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "explicit fallback despite agent lookup failure")
		expect(f.switches[0]?.model).toEqual(backupB)
	})

	test("invalid legacy entries do not discard valid backups or retain a stale chain", async () => {
		const configured = agent(["backup/b"])
		const f = await fixture({ timeout_seconds: 0 }, [configured])
		await invokeContext(f)
		configured.request.body = { fallback_models: ["invalid", "backup/reloaded"] }
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "valid backup after malformed legacy ref")
		expect(f.switches[0]?.model.id).toBe("reloaded")
	})
})

describe("setupV2 foreground child coordination", () => {
	test("an explicit human prompt can resume a child during a cancelled hand-off", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		const admission = gate()
		f.override("prompt", () => admission.promise)
		f.override("interrupt", () => ({ interrupted: false }))
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child prompt admission pending")
		const parent = new AbortController()
		const result = f.subagent(parent.signal).catch((error) => error)
		await settle(10)
		parent.abort()
		await result
		await f.callbacks.get("prompt")!(userPrompt())
		await invokeContext(f, sessionID, "build", backupB)
		admission.open()
		await settle(20)
		expect(f.interrupts).toHaveLength(1)
	})

	test("a failed cancellation interrupt does not reject the late context hook", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		const wait = gate()
		f.override("wait", () => wait.promise)
		f.override("interrupt", () => { throw new Error("interrupt failed") })
		await invokeContext(f)
		failure(f)
		await until(() => f.waits.length === 1, "hand-off waiting")
		const parent = new AbortController()
		const result = f.subagent(parent.signal).catch((error) => error)
		await settle(10)
		parent.abort()
		await result
		await expect(invokeContext(f, sessionID, "build", backupB)).resolves.toBeUndefined()
		wait.open()
		await settle(20)
		expect(f.prompts).toEqual([])
	})

	test("parent cancellation during admission cannot revive the admitted backup context", async () => {
		const f = await fixture({ timeout_seconds: 0.03, fallback_models: ["backup/b", "backup/c"] })
		const admission = gate()
		f.override("prompt", () => admission.promise)
		f.override("interrupt", () => ({ interrupted: false }))
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child prompt admission pending")
		const parent = new AbortController()
		const result = f.subagent(parent.signal).catch((error) => error)
		await settle(10)
		parent.abort()
		expect((await result).message).toBe("Native subagent failed")
		admission.open()
		await until(() => f.interrupts.length >= 2, "post-admission cancellation")
		await invokeContext(f, sessionID, "build", backupB)
		failure(f)
		await settle(70)
		expect(f.prompts).toHaveLength(1)
		expect(f.switches.map((value) => value.model.id)).toEqual(["b"])
	})

	for (const staleOutcome of ["failed", "succeeded"] as const) {
		test(`stale ${staleOutcome} idle timestamps after stream loss cannot complete recovery`, async () => {
			const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
			await invokeContext(f)
			failure(f)
			await until(() => f.prompts.length === 1, "child fallback admission")
			await invokeContext(f, sessionID, "build", backupB)
			f.override("get", () => ({ outcome: staleOutcome, time: { idle: 0 } }))
			let finished = false
			const result = f.subagent().then((value) => { finished = true; return value })
			await settle(10)
			f.closeEvents(new Error("stream disconnected"))
			await settle(90)
			expect(finished).toBe(false)
			f.override("get", () => ({ outcome: "succeeded", time: { idle: Date.now() + 1 } }))
			expect(await result).toMatchObject({ output: { output: "RECOVERED_CHILD_RESULT" } })
		})
	}

	test("parent cancellation cancels an idle hand-off even when interrupt is a no-op", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		const wait = gate()
		f.override("wait", () => wait.promise)
		f.override("interrupt", () => ({ interrupted: false }))
		await invokeContext(f)
		failure(f)
		await until(() => f.waits.length === 1, "hand-off waiting for the failed execution")
		const parent = new AbortController()
		const result = f.subagent(parent.signal).catch((error) => error)
		await settle(10)
		parent.abort()
		expect((await result).message).toBe("Native subagent failed")
		wait.open()
		await settle(30)
		expect(f.switches).toEqual([])
		expect(f.prompts).toEqual([])
	})

	test("a child that succeeds without a fallback ends the recovery wait", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		f.override("get", () => ({ outcome: "succeeded" }))
		const result = f.subagent().catch((error) => error)
		await settle(10)
		f.emit("session.execution.succeeded", { sessionID })
		expect((await result).message).toBe("Native subagent failed")
		expect(f.prompts).toEqual([])
	})

	test("a failed TTFT hand-off ends recovery even when the host outcome is interrupted", async () => {
		const f = await fixture({ timeout_seconds: 0.03, fallback_models: ["backup/b"] })
		f.override("switchModel", () => { throw new Error("switch failed") })
		f.override("get", () => ({ outcome: "interrupted" }))
		await invokeContext(f)
		const result = f.subagent().catch((error) => error)
		expect((await result).message).toBe("Native subagent failed")
		expect(f.interrupts).toHaveLength(1)
		expect(f.prompts).toEqual([])
	})

	test("a terminal child outcome after event-stream loss does not stall the parent", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child fallback admission")
		await invokeContext(f, sessionID, "build", backupB)
		f.override("get", () => ({ outcome: "failed" }))
		const result = f.subagent().catch((error) => error)
		await settle(10)
		f.closeEvents(new Error("stream disconnected"))
		expect((await result).message).toBe("Native subagent failed")
	})

	test("a long-running backup is not detached by an elapsed-time deadline", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child fallback admission")
		await invokeContext(f, sessionID, "build", backupB)
		f.override("get", () => ({ outcome: "failed" }))
		let finished = false
		const result = f.subagent().then((value) => { finished = true; return value })
		await settle(10)
		const now = Date.now()
		const clock = spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000)
		try {
			await settle(70)
			expect(finished).toBe(false)
		} finally { clock.mockRestore() }
		f.override("get", () => ({ outcome: "succeeded" }))
		f.emit("session.execution.succeeded", { sessionID })
		expect(await result).toMatchObject({ output: { output: "RECOVERED_CHILD_RESULT" } })
	})

	test("waits for late failure events and delayed continuation startup before delivering the child answer", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		f.override("get", () => ({ outcome: "failed" }))
		let finished = false
		const result = f.subagent().then((value) => { finished = true; return value })
		await settle(60)
		failure(f)
		await until(() => f.prompts.length === 1, "child fallback admission")
		// The durable outcome still belongs to the failed primary; queued
		// startup can legitimately take longer than any fixed grace window.
		await settle(350)
		expect(finished).toBe(false)
		await invokeContext(f, sessionID, "build", backupB)
		f.override("get", () => ({ outcome: "succeeded" }))
		f.emit("session.execution.succeeded", { sessionID })
		expect(await result).toMatchObject({ output: { status: "completed", output: "RECOVERED_CHILD_RESULT" } })
	})

	test("preserves the native error when the child exhausts its fallback budget", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"], max_fallback_attempts: 1 })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child fallback admission")
		f.override("get", () => ({ outcome: "failed" }))
		const result = f.subagent().catch((error) => error)
		await invokeContext(f, sessionID, "build", backupB)
		failure(f)
		expect((await result).message).toBe("Native subagent failed")
		expect(f.prompts).toHaveLength(1)
	})

	test("parent cancellation interrupts the recovering child even during a pending outcome read", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child fallback admission")
		await invokeContext(f, sessionID, "build", backupB)
		f.override("get", () => new Promise(() => {}))
		const parent = new AbortController()
		const result = f.subagent(parent.signal).catch((error) => error)
		await settle(10)
		parent.abort()
		expect((await result).message).toBe("Native subagent failed")
		expect(f.interrupts).toEqual([{ sessionID, resume: false }])
	})

	test("unloading ends a foreground wait even when its outcome read never resolves", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child fallback admission")
		await invokeContext(f, sessionID, "build", backupB)
		f.override("get", () => new Promise(() => {}))
		const result = f.subagent().catch((error) => error)
		await settle(10)
		await f.dispose()
		expect((await result).message).toBe("Native subagent failed")
	})

	test("foreground_task_fallback false retains the native failure", async () => {
		const f = await fixture({ foreground_task_fallback: false, timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "child fallback admission")
		await expect(f.subagent()).rejects.toThrow("Native subagent failed")
	})
})

describe("setupV2 cascading and admission races", () => {
	test("failure of fallback B while prompt(B) admission is pending queues C and dispatches it after admission", async () => {
		const f = await fixture({ fallback_models: ["backup/b", "backup/c"], timeout_seconds: 0 })
		const admission = gate()
		f.override("prompt", () => admission.promise)
		await invokeContext(f)
		stepStarted(f, sessionID, "assistant-1")
		await settle(5)
		failure(f, sessionID, "assistant-1", serverError)
		await until(() => f.prompts.length === 1, "prompt(B) admission started")
		expect(f.switches.map((s) => s.model.id)).toEqual(["b"])

		// B's new step fails while admission for B is still pending.
		await invokeContext(f, sessionID, "build", backupB)
		stepStarted(f, sessionID, "assistant-2", "build", backupB)
		await settle(5)
		failure(f, sessionID, "assistant-2", serverError)
		await settle(20)
		expect(f.switches.map((s) => s.model.id)).toEqual(["b"])
		expect(f.prompts).toHaveLength(1)

		f.override("prompt", undefined)
		admission.open()
		await until(() => f.prompts.length === 2, "queued dispatch to C after admission")
		expect(f.switches.map((s) => s.model.id)).toEqual(["b", "c"])
		expect(f.waits).toHaveLength(2)
		expect(f.prompts[1].metadata).toEqual({ "opencode-fallback": true })
	})

	test("late self-interrupt event after the fallback context does not cancel the new request TTFT", async () => {
		const f = await fixture({ fallback_models: ["backup/b", "backup/c"], timeout_seconds: 0.03 })
		await invokeContext(f)
		await until(() => f.prompts.length === 1, "first TTFT fallback to B")

		// The new B request starts its own window before the old self-interrupt is delivered.
		await invokeContext(f, sessionID, "build", backupB)
		f.emit("session.execution.interrupted", { sessionID })
		await until(() => f.prompts.length === 2, "B TTFT fallback to C", 1500)
		expect(f.switches.map((s) => s.model.id)).toEqual(["b", "c"])
		expect(f.interrupts).toHaveLength(2)
	})

	test("execution.succeeded clears a retry-planned fallback so a later non-retryable failure does not dispatch", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		f.emit("session.execution.succeeded", { sessionID, assistantMessageID: "assistant-1" })
		f.emit("session.execution.failed", { sessionID, assistantMessageID: "assistant-1", error: badRequest })
		await settle(40)
		expect(f.waits).toEqual([])
		expect(f.switches).toEqual([])
		expect(f.prompts).toEqual([])
	})
})

describe("setupV2 steer and auxiliary requests", () => {
	test("a compaction failure is never resumed as an ordinary task prompt", async () => {
		const f = await fixture({ timeout_seconds: 0, fallback_models: ["backup/b"] })
		await invokeContext(f)
		modelRequest(f, "compaction")
		f.emit("session.compaction.failed", { sessionID, error: retryableError })
		f.emit("session.execution.failed", { sessionID, error: retryableError })
		await settle()
		expect(f.prompts).toEqual([])
		expect(f.switches).toEqual([])
	})
	test("steer prompt during an active request does not clear the TTFT window", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0.05 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		await f.callbacks.get("prompt")!(userPrompt(sessionID))
		expect(f.gets).toEqual([])
		await until(() => f.prompts.length === 1, "TTFT fallback after steer", 1500)
		expect(f.interrupts).toEqual([{ sessionID, resume: false }])
		expect(f.switches.map((s) => s.model.id)).toEqual(["b"])
	})

	test("steer prompt during an active request keeps a retry-planned pending fallback", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		await f.callbacks.get("prompt")!(userPrompt(sessionID))
		f.emit("session.execution.failed", { sessionID, assistantMessageID: "assistant-1", error: retryableError })
		await until(() => f.prompts.length === 1, "pending fallback survives steer")
		expect(f.switches.map((s) => s.model.id)).toEqual(["b"])
	})

	for (const kind of ["title", "compaction"] as const) {
		test(`auxiliary ${kind} model.request leaves its provider retry to the host`, async () => {
			const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
			await invokeContext(f)
			stepStarted(f)
			f.emit("session.execution.succeeded", { sessionID })
			await settle(5)
			modelRequest(f, kind)
			await settle(5)
			const retry = retryEvent()
			const decision = retry.decision
			f.callbacks.get("retry")!(retry)
			expect(retry.decision).toBe(decision)
		})
	}
})

describe("setupV2 integrated compaction lifecycle", () => {
	test("compaction-specific resolved legacy chain takes precedence over parent and global chains", async () => {
		const f = await fixture({ fallback_models: ["backup/global"], timeout_seconds: 0 })
		f.override("agentGet", ({ agentID }) => ({ data: {
			id: agentID,
			model: original,
			request: { body: { fallback_models: agentID === "compaction" ? ["backup/compaction"] : ["backup/parent"] } },
		} }))
		f.override("prompt", async ({ sessionID: childID }) => {
			if (f.compactionChildren.find(({ sessionID }) => sessionID === childID)?.model.id === "primary") {
				f.emit("session.execution.failed", { sessionID: childID, error: retryableError })
				await settle(10)
			}
		})
		const event = compactionEvent()
		await f.callbacks.get("compaction")!(event)
		expect(f.compactionChildren.map(({ model }) => model.id)).toEqual(["primary", "compaction"])
		expect(event.result).toMatchObject({ summary: "RECOVERED_CHILD_RESULT", metadata: { model: "backup/compaction", fallback: true } })
		expect(f.removedChildren).toEqual(f.compactionChildren.map(({ sessionID }) => sessionID))
	})

	test("clearing the main TTFT timer does not dispatch ordinary fallback during compaction", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0.02 })
		const admission = gate()
		f.override("create", () => admission.promise)
		await invokeContext(f)
		const run = f.callbacks.get("compaction")!(compactionEvent())
		await until(() => f.compactionChildren.length === 1, "compaction child admission")
		await settle(70)
		expect(f.interrupts).toEqual([])
		expect(f.prompts).toEqual([])
		admission.open()
		await run
		expect(f.prompts.every(({ sessionID: prompted }) => prompted !== sessionID)).toBe(true)
	})

	test("internal compaction children skip main agent resolution and delayed step events after cleanup", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0.03 })
		await invokeContext(f)
		const event = compactionEvent()
		await f.callbacks.get("compaction")!(event)
		const childID = f.compactionChildren[0].sessionID
		expect(f.agentLookups.filter((agentID) => agentID === "compaction")).toHaveLength(1)
		expect(f.removedChildren).toEqual([childID])
		f.emit("session.step.started", { sessionID: childID, assistantMessageID: "late-step", agent: "compaction", model: original }, Date.now(), {
			directory: f.directory,
			workspaceID: "test-workspace",
		})
		await settle(70)
		expect(f.interrupts).toEqual([])
		expect(f.prompts.map(({ sessionID: prompted }) => prompted)).toEqual([childID])
	})

	test("event-stream loss releases owned compaction to native generation without ordinary fallback", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0.02 })
		const admission = gate()
		f.override("prompt", () => admission.promise)
		const event = compactionEvent("untracked-parent")
		const run = f.callbacks.get("compaction")!(event)
		await until(() => f.prompts.length === 1, "internal compaction prompt admission")
		f.closeEvents(new Error("event stream lost"))
		try {
			await until(() => f.subscriptions >= 2, "event stream reconnect after loss")
		} finally {
			admission.open()
		}
		await until(() => f.interrupts.length === 1, "compaction child interrupted after stream loss")
		await expect(run).resolves.toBeUndefined()
		expect(event.result).toBeUndefined()
		expect(f.interrupts[0].sessionID).toBe(f.compactionChildren[0].sessionID)
		expect(f.prompts).toHaveLength(1)
		expect(f.switches).toEqual([])
		expect(f.removedChildren).toEqual([f.compactionChildren[0].sessionID])
	})

	test("fallback notification occurs after prompt admission, while disabled notifications emit nothing", async () => {
		const admission = gate()
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0, notify_on_fallback: true })
		f.override("prompt", () => admission.promise)
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		failure(f)
		await until(() => f.prompts.length === 1, "primary fallback prompt admission")
		expect(f.emittedNotifications).toEqual([])
		admission.open()
		await until(() => f.emittedNotifications.length === 1, "notification after prompt admission")
		expect(f.emittedNotifications[0]).toMatchObject({ name: "notification", data: { kind: "primary", from: "provider/primary", to: "backup/b" } })

		const disabled = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0, notify_on_fallback: false })
		await invokeContext(disabled)
		stepStarted(disabled)
		await settle(5)
		failure(disabled)
		await until(() => disabled.prompts.length === 1, "fallback prompt with notifications disabled")
		await settle(10)
		expect(disabled.emittedNotifications).toEqual([])
	})
})

describe("setupV2 late execution events", () => {
	test("host-resolved default variant preserves fallback chain position and attempt limit", async () => {
		const f = await fixture({ fallback_models: ["backup/b", "backup/c"], max_fallback_attempts: 1, timeout_seconds: 0 })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "first fallback")
		await invokeContext(f, sessionID, "build", { ...backupB, variant: "default" })
		const retry = retryEvent("build", { ...backupB, variant: "default" })
		f.callbacks.get("retry")!(retry)
		f.emit("session.execution.failed", { sessionID, error: retryableError })
		await settle()
		expect(retry.decision).toEqual({ retry: false })
		expect(f.switches.map((value) => value.model.id)).toEqual(["b"])
	})
	test("a no-op TTFT interrupt does not swallow later user cancellation", async () => {
		const f = await fixture({ fallback_models: ["backup/b", "backup/c"], timeout_seconds: 0.04 })
		f.override("interrupt", () => ({ interrupted: false }))
		await invokeContext(f)
		await until(() => f.prompts.length === 1, "first TTFT fallback")
		await settle(5)
		await invokeContext(f, sessionID, "build", backupB)
		f.emit("session.execution.interrupted", { sessionID, reason: "user" })
		await settle(100)
		expect(f.switches.map((value) => value.model.id)).toEqual(["b"])
	})

	test("late idle from the old execution cannot clear the new fallback TTFT", async () => {
		const f = await fixture({ fallback_models: ["backup/b", "backup/c"], timeout_seconds: 0.04 })
		await invokeContext(f)
		const oldIdleCreated = Date.now()
		failure(f)
		await until(() => f.prompts.length === 1, "first fallback")
		await settle(5)
		await invokeContext(f, sessionID, "build", backupB)
		f.emit("session.idle", { sessionID }, oldIdleCreated)
		await until(() => f.prompts.length === 2, "hung fallback times out")
		expect(f.switches.map((value) => value.model.id)).toEqual(["b", "c"])
	})

	test("a concurrent title request does not replace primary retry ownership", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		modelRequest(f, "primary")
		modelRequest(f, "title")
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
	})
})

describe("setupV2 event stream health", () => {
	test("retry leaves the native decision untouched while the stream is ended and until reconnect", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		f.closeEvents()
		await settle(20)
		const retry = retryEvent()
		const decision = retry.decision
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toBe(decision)
		await until(() => f.subscriptions === 2, "event stream reconnect", 3000)
		f.emit("session.idle", { sessionID })
		await settle(10)
		const afterReconnect = retryEvent()
		f.callbacks.get("retry")!(afterReconnect)
		expect(afterReconnect.decision).toEqual({ retry: false })
	})

	test("retry leaves the native decision untouched while the stream is failed and until reconnect", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		f.closeEvents(new Error("socket reset"))
		await settle(20)
		const retry = retryEvent()
		const decision = retry.decision
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toBe(decision)
		await until(() => f.subscriptions === 2, "event stream reconnect after failure", 3000)
		f.emit("session.idle", { sessionID })
		await settle(10)
		const afterReconnect = retryEvent()
		f.callbacks.get("retry")!(afterReconnect)
		expect(afterReconnect.decision).toEqual({ retry: false })
	})
})

describe("setupV2 prompt hook failures", () => {
	test("a session.get failure in the prompt hook does not reject the user prompt", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		f.emit("session.execution.succeeded", { sessionID, assistantMessageID: "assistant-1" })
		await settle(10)
		f.override("get", () => { throw new Error("get unavailable") })
		await expect(f.callbacks.get("prompt")!(userPrompt(sessionID))).resolves.toBeUndefined()
		expect(f.gets).toEqual([sessionID])
	})

	test("a switchModel failure during cooldown recovery does not reject the user prompt", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], cooldown_seconds: 0.03, timeout_seconds: 0 })
		await invokeContext(f)
		stepStarted(f)
		await settle(5)
		failure(f)
		await until(() => f.prompts.length === 1, "fallback to B before recovery")
		await settle(45)
		f.override("switchModel", () => { throw new Error("switch unavailable") })
		await expect(f.callbacks.get("prompt")!(userPrompt(sessionID))).resolves.toBeUndefined()
		expect(f.switches.map((s) => s.model.id)).toEqual(["b", "primary"])
	})
})

describe("setupV2 model inventory validation", () => {
	test("stale configured IDs absent from the host inventory are never switched to", async () => {
		const f = await fixture({ fallback_models: ["backup/gone", "backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		failure(f)
		await until(() => f.prompts.length === 1, "fallback to verified backup")
		expect(f.switches).toEqual([{ sessionID, model: backupB }])
	})

	test("next-valid candidate skips a stale ID later in the chain", async () => {
		const f = await fixture({ fallback_models: ["backup/b", "backup/gone", "backup/c"], timeout_seconds: 0 })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "fallback to b")
		await invokeContext(f, sessionID, "build", backupB)
		failure(f, sessionID, "backup-assistant")
		await until(() => f.prompts.length === 2, "fallback to c")
		expect(f.switches.map((value) => value.model.id)).toEqual(["b", "c"])
	})

	test("no verified candidate keeps native retry and never arms TTFT", async () => {
		const f = await fixture({ fallback_models: ["backup/gone"], timeout_seconds: 0.03 })
		await invokeContext(f)
		const retry = retryEvent()
		const decision = retry.decision
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toBe(decision)
		await settle(80)
		expect(f.interrupts).toEqual([])
		expect(f.switches).toEqual([])
		expect(f.prompts).toEqual([])
	})

	test("an unavailable inventory at setup preserves native retry without rejecting setup", async () => {
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 }, [], () => { throw new Error("model list unavailable") })
		await invokeContext(f)
		const retry = retryEvent()
		const decision = retry.decision
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toBe(decision)
		failure(f)
		await settle(40)
		expect(f.switches).toEqual([])
		expect(f.prompts).toEqual([])
	})

	test("a model.updated refresh restores fallback once the inventory is trustworthy again", async () => {
		let listable = false
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 }, [], () => {
			if (!listable) throw new Error("model list unavailable")
			return { data: KNOWN_MODELS.map((ref) => modelInfo(ref)) }
		})
		await invokeContext(f)
		listable = true
		f.emit("model.updated", {})
		await until(() => f.modelLists >= 2, "inventory refresh after model.updated")
		await settle(10)
		await invokeContext(f)
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		failure(f)
		await until(() => f.prompts.length === 1, "fallback after inventory recovery")
		expect(f.switches).toEqual([{ sessionID, model: backupB }])
	})

	test("a candidate removed before dispatch is replaced by the next verified candidate", async () => {
		let hideB = false
		const f = await fixture({ fallback_models: ["backup/b", "backup/c"], timeout_seconds: 0 }, [], () => ({
			data: KNOWN_MODELS.filter((ref) => !(hideB && ref === "backup/b")).map((ref) => modelInfo(ref)),
		}))
		await invokeContext(f)
		const retry = retryEvent()
		f.callbacks.get("retry")!(retry)
		expect(retry.decision).toEqual({ retry: false })
		hideB = true
		failure(f)
		await until(() => f.prompts.length === 1, "fallback to the next verified candidate")
		expect(f.switches.map((value) => value.model.id)).toEqual(["c"])
	})

	test("a candidate removed before dispatch with no remaining verified candidate is never switched to", async () => {
		let hideB = false
		const f = await fixture({ fallback_models: ["backup/b"], timeout_seconds: 0 }, [], () => ({
			data: KNOWN_MODELS.filter((ref) => !(hideB && ref === "backup/b")).map((ref) => modelInfo(ref)),
		}))
		await invokeContext(f)
		hideB = true
		failure(f)
		await settle(40)
		expect(f.switches).toEqual([])
		expect(f.prompts).toEqual([])
	})

	test("a variant the host does not list is skipped", async () => {
		const f = await fixture({ fallback_models: ["backup/special#missing", "backup/b"], timeout_seconds: 0 })
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "fallback past unknown variant")
		expect(f.switches).toEqual([{ sessionID, model: backupB }])
	})

	test("a disabled inventory entry is skipped", async () => {
		const f = await fixture({ fallback_models: ["backup/b", "backup/c"], timeout_seconds: 0 }, [], () => ({
			data: KNOWN_MODELS.map((ref) => modelInfo(ref, ref !== "backup/b")),
		}))
		await invokeContext(f)
		failure(f)
		await until(() => f.prompts.length === 1, "fallback past disabled model")
		expect(f.switches.map((value) => value.model.id)).toEqual(["c"])
	})
})
