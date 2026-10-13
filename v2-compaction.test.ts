import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import { DEFAULT_CONFIG } from "./constants"
import { installV2CompactionFallback, SUMMARY_INSTRUCTION } from "./v2-compaction"

type Reply = {
	text?: string
	/** Text-part provider state; must never be promoted to message level. */
	textState?: Record<string, unknown>
	providerState?: Record<string, unknown>
	empty?: boolean
	/** Emit a text delta immediately before finishing. */
	delta?: boolean
	/** Never finish until interrupted. */
	hang?: boolean
	/** Finish after this many ms without emitting a delta. */
	delayMs?: number
	error?: { type: string; message: string; status?: number }
	/** Host does not run the child's context hook, so the request is never scoped. */
	skipContext?: boolean
	/** Model rejects assistant-prefill requests, as some providers do. */
	rejectAssistantPrefill?: boolean
}

const RETRYABLE = { type: "provider", message: "rate limit exceeded", status: 429 }
const FATAL = { type: "invalid", message: "bad request", status: 400 }
const TOKENS = { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
const DENY_ALL = [{ action: "*", resource: "*", effect: "deny" }]

function defer() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

function fixture(options: {
	/** Receives the model ref and the 1-based child index. */
	reply?: (model: string, index: number) => Reply
	createGate?: Promise<void>
	promptGate?: Promise<void>
	chainGate?: Promise<void>
	removeFails?: boolean
	removeGate?: Promise<void>
	timeout?: number
	cooldown?: number
	chain?: string[]
	streamHealthy?: () => boolean
	/** Options the host computes for each child model before the context hook runs. */
	hostOptions?: Record<string, unknown>
} = {}) {
	const trace: string[] = []
	const created: Array<{ parentID?: string; agent?: string; permissions?: unknown; model?: { id: string; providerID: string; variant?: string } }> = []
	const requests: Array<Record<string, any>> = []
	const notified: unknown[] = []
	const contexts = new Map<string, unknown[]>()
	const done = new Map<string, ReturnType<typeof defer>>()
	const childModel = new Map<string, string>()
	const hooks = new Map<string, (input: any) => unknown>()
	let handle: (event: unknown) => void = () => {}
	let count = 0
	const reply = options.reply ?? (() => ({ text: "summary", tokens: TOKENS }))

	const ctx = {
		location: { directory: "/repo" },
		session: {
			async create(input: any) {
				created.push(input)
				const index = ++count
				const id = `child-${index}`
				done.set(id, defer())
				childModel.set(id, `${input.model.providerID}/${input.model.id}${input.model.variant ? `#${input.model.variant}` : ""}`)
				if (options.createGate) await options.createGate
				trace.push(`create:${id}`)
				return { id }
			},
			async prompt(input: { sessionID: string }) {
				const id = input.sessionID
				const model = childModel.get(id)!
				const index = Number(id.slice("child-".length))
				const r = reply(model, index)
				trace.push(`prompt:${id}`)
				if (options.promptGate) await options.promptGate
				trace.push(`prompt-settled:${id}`)
				// Like the host, run the child's context hook before the model request.
				if (!r.skipContext) {
					const request = {
						sessionID: id,
						agent: "compaction",
						model: { id: model.split("/")[1], providerID: model.split("/")[0] },
						system: [{ type: "text", text: "child-default" }],
						messages: [{ type: "user", id: "stale", text: "stale" }],
						options: { ...options.hostOptions },
						tools: { bash: { description: "shell", input: {} } },
					}
					await hooks.get("context")?.(request)
					requests.push(request)
					if (r.rejectAssistantPrefill && request.messages.at(-1)?.role !== "user") {
						const error = { type: "provider", message: "this model does not support assistant message prefill", status: 400 }
						contexts.set(id, [{
							id: `m-${id}`, type: "assistant", agent: "compaction",
							model: { id: model.split("/")[1], providerID: model.split("/")[0] },
							time: { created: 0 }, content: [], error, finish: "error",
						}])
						setTimeout(() => {
							handle({ type: "session.execution.failed", data: { sessionID: id, error } })
							done.get(id)!.resolve()
						}, 0)
						return
					}
				}
				const assistant = {
					id: `m-${id}`, type: "assistant", agent: "compaction",
					model: { id: model.split("/")[1], providerID: model.split("/")[0] },
					time: { created: 0 },
					content: r.empty ? [] : [{ type: "text", text: r.text ?? "summary", state: r.textState }],
					providerState: r.providerState,
					tokens: TOKENS,
				}
				const finish = () => {
					if (r.delta) handle({ type: "session.text.delta", data: { sessionID: id, assistantMessageID: `m-${id}`, delta: "x" } })
					contexts.set(id, [assistant])
					done.get(id)!.resolve()
				}
				if (r.hang) return
				if (r.error) {
					contexts.set(id, [{ ...assistant, error: r.error, finish: "error" }])
					setTimeout(() => {
						handle({ type: "session.execution.failed", data: { sessionID: id, error: r.error } })
						done.get(id)!.resolve()
					}, 0)
					return
				}
				if (r.delayMs) setTimeout(finish, r.delayMs)
				else finish()
			},
			async wait(input: { sessionID: string }) {
				await done.get(input.sessionID)!.promise
			},
			async interrupt(input: { sessionID: string }) {
				trace.push(`interrupt:${input.sessionID}`)
				done.get(input.sessionID)?.resolve()
				return { interrupted: true }
			},
			async context(input: { sessionID: string }) {
				return contexts.get(input.sessionID) ?? []
			},
			async remove(input: { sessionID: string }) {
				trace.push(`remove:${input.sessionID}`)
				if (options.removeGate) await options.removeGate
				if (options.removeFails) throw new Error("remove failed")
			},
			async hook(name: string, callback: (input: any) => unknown) {
				hooks.set(name, callback)
				return { dispose: async () => { hooks.delete(name) } }
			},
		},
	} as unknown as Plugin.Context

	const config = { ...DEFAULT_CONFIG, timeout_seconds: options.timeout ?? 0, cooldown_seconds: options.cooldown ?? 0 }
	const chainModels = options.chain ?? ["provider/backup"]
	const install = installV2CompactionFallback(ctx, {
		config,
		chain: async () => {
			if (options.chainGate) await options.chainGate
			return chainModels
		},
		notify: async (input) => { notified.push(input) },
		clearMainTimer: () => {},
		streamHealthy: options.streamHealthy,
	})
	const setHandle = async () => {
		const installed = await install
		handle = (event) => installed.handleEvent(event as never)
		return installed
	}

	const parentEvent = (overrides: Partial<SessionHooks["compaction"]> = {}) => ({
		sessionID: "parent",
		agent: "build",
		model: { id: "primary", providerID: "provider" },
		system: [{ type: "text", text: "system" }],
		messages: [
			{ role: "user", id: "u1", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", id: "a1", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }] },
		],
		options: { temperature: 0.2 },
		tools: { bash: { description: "shell", input: {} } },
		kind: "compaction",
		...overrides,
	}) as unknown as SessionHooks["compaction"]

	return {
		trace, created, requests, notified, setHandle, parentEvent,
		install,
		get compaction() { return hooks.get("compaction") as (event: SessionHooks["compaction"]) => Promise<void> },
		get context() { return hooks.get("context") as (event: any) => Promise<void> },
		get retry() { return hooks.get("retry") as (event: any) => void },
	}
}

describe("v2 compaction fallback", () => {
	test("cancellation during successful child cleanup cannot publish a summary", async () => {
		const gate = defer()
		const f = fixture({ removeGate: gate.promise })
		const installed = await f.setHandle()
		const event = f.parentEvent()
		const run = f.compaction(event)
		await tick()
		expect(f.trace).toContain("remove:child-1")
		installed.cancel("parent")
		gate.resolve()
		await expect(run).rejects.toBeDefined()
		expect(event.result).toBeUndefined()
	})
	test("does not intercept when the fallback chain is empty", async () => {
		const f = fixture({ chain: [] })
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(f.created).toHaveLength(0)
		expect(event.result).toBeUndefined()
	})

	test("runs the original model in a child with denied permissions and returns its result", async () => {
		const f = fixture({ reply: () => ({ text: "summary", providerState: { id: "p" }, tokens: TOKENS }) })
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(f.created[0]).toMatchObject({
			parentID: "parent",
			agent: "build",
			model: { id: "primary", providerID: "provider" },
			permissions: DENY_ALL,
		})
		expect(event.result).toMatchObject({
			summary: "summary",
			providerState: { id: "p" },
			tokens: TOKENS,
			metadata: { model: "provider/primary", fallback: false },
		})
		expect(f.trace).toEqual(["create:child-1", "prompt:child-1", "prompt-settled:child-1", "remove:child-1"])
	})

	test("succeeds with a provider that rejects assistant-prefill requests and preserves saved history", async () => {
		const f = fixture({ reply: () => ({ text: "accepted summary", rejectAssistantPrefill: true }) })
		await f.setHandle()
		const event = f.parentEvent()
		const originalMessages = JSON.parse(JSON.stringify(event.messages))
		await f.compaction(event)
		expect(f.created).toHaveLength(1)
		expect(f.requests[0].messages.slice(0, originalMessages.length)).toEqual(originalMessages)
		expect(f.requests[0].messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }] })
		expect(f.requests[0].messages.at(-2)).toEqual(originalMessages.at(-1))
		expect(event.result?.summary).toBe("accepted summary")
	})

	test("the summary instruction is appended after every final role, including a real user turn", async () => {
		const endings: Array<{ name: string; messages: unknown[] }> = [
			{ name: "user", messages: [{ role: "user", id: "u2", content: [{ type: "text", text: "last user message" }] }] },
			{ name: "assistant", messages: [{ role: "assistant", id: "a2", content: [{ type: "text", text: "reply" }] }] },
			{ name: "tool", messages: [{ role: "tool", id: "t2", content: [{ type: "tool-result", toolCallId: "c1", output: {} }] }] },
			{ name: "empty", messages: [] },
		]
		for (const ending of endings) {
			const f = fixture({ reply: () => ({ hang: true }) })
			const installed = await f.setHandle()
			const event = f.parentEvent({ messages: ending.messages as never })
			const originalMessages = JSON.parse(JSON.stringify(event.messages))
			const run = f.compaction(event)
			await tick()
			expect({ name: ending.name, messages: f.requests[0].messages }).toEqual({
				name: ending.name,
				messages: [...originalMessages, { role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }] }],
			})
			installed.cancel("parent")
			await expect(run).rejects.toBeDefined()
		}
	})

	test("the summary instruction carries the native template headings and checkpoint-merge rules", () => {
		const headings = [
			"## Objective",
			"## Requirements",
			"## Decisions",
			"## Work State",
			"### Completed",
			"### Active",
			"### Blocked",
			"## Next Move",
			"## Relevant Files",
			"## Important Context",
		]
		for (const heading of headings) expect(SUMMARY_INSTRUCTION.split("\n")).toContain(heading)
		expect(SUMMARY_INSTRUCTION.startsWith("You MUST summarize the conversation above into a structured summary")).toBe(true)
		expect(SUMMARY_INSTRUCTION).toContain("<conversation-checkpoint>")
		expect(SUMMARY_INSTRUCTION).toContain("Newer history always takes precedence over the existing checkpoint.")
		expect(SUMMARY_INSTRUCTION).toContain("Do not continue the task or call tools.")
		expect(SUMMARY_INSTRUCTION.endsWith("Do not include a preamble, explanation, or other commentary.")).toBe(true)
		// The host treats this heading as a legacy checkpoint marker, so the instruction must not emit it.
		expect(SUMMARY_INSTRUCTION).not.toContain("## Additional Context")
	})

	test("the host-run child context is a scoped clone with tools removed; parent requests are untouched", async () => {
		const f = fixture({ reply: () => ({ hang: true }) })
		const installed = await f.setHandle()
		const event = f.parentEvent()
		const originalMessages = JSON.parse(JSON.stringify(event.messages))
		const compactionInstruction = { role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }] }
		const run = f.compaction(event)
		await tick()
		expect(f.requests).toHaveLength(1)
		expect(f.requests[0].messages).toEqual([...originalMessages, compactionInstruction])
		expect(f.requests[0].system).toEqual([{ type: "text", text: "system" }])
		expect(f.requests[0].options).toEqual({ temperature: 0.2 })
		expect(f.requests[0].tools).toEqual({})
		// Mutations to what the child received must not leak into later requests.
		f.requests[0].messages[0].text = "mutated"
		const again = { sessionID: "child-1", agent: "build", model: event.model, system: [], messages: [] as unknown[], options: {}, tools: {} }
		await f.context(again)
		expect(again.messages).toEqual([...originalMessages, compactionInstruction])
		const parent = { sessionID: "parent", agent: "build", model: event.model, system: [], messages: [] as unknown[], options: {}, tools: { bash: {} } }
		await f.context(parent)
		expect(parent.tools).toEqual({ bash: {} })
		expect(parent.messages).toEqual([])
		installed.cancel("parent")
		await expect(run).rejects.toBeDefined()
	})

	test("keeps the saved final user message and appends the summary instruction after it", async () => {
		const f = fixture({ reply: () => ({ hang: true }) })
		const installed = await f.setHandle()
		const event = f.parentEvent({
			messages: [
				{ role: "assistant", id: "a1", content: [{ type: "text", text: "prior response" }] },
				{ role: "user", id: "u2", content: [{ type: "text", text: "last user message" }] },
			] as never,
		})
		const originalMessages = JSON.parse(JSON.stringify(event.messages))
		const run = f.compaction(event)
		await tick()
		expect(f.requests[0].messages).toEqual([...originalMessages, { role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }] }])
		installed.cancel("parent")
		await expect(run).rejects.toBeDefined()
	})

	test("falls back after a retryable original failure and reports the used model", async () => {
		const f = fixture({
			reply: (model) => model === "provider/primary" ? { error: RETRYABLE } : { text: "backup summary" },
		})
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(f.created.map((c) => c.model?.id)).toEqual(["primary", "backup"])
		expect(event.result).toMatchObject({ summary: "backup summary", metadata: { model: "provider/backup", fallback: true } })
		expect(f.notified).toEqual([expect.objectContaining({ sessionID: "parent", from: "provider/primary", to: "provider/backup", kind: "compaction" })])
	})

	test("passes fallback variants through to the child model", async () => {
		const f = fixture({
			chain: ["provider/backup#high"],
			reply: (model) => model === "provider/primary" ? { error: RETRYABLE } : { text: "ok" },
		})
		await f.setHandle()
		await f.compaction(f.parentEvent())
		expect(f.created[1].model).toEqual({ id: "backup", providerID: "provider", variant: "high" })
	})

	test("a non-retryable original failure propagates without fallback, wrapped with its cause", async () => {
		const f = fixture({ reply: () => ({ error: FATAL }) })
		await f.setHandle()
		const event = f.parentEvent()
		const error = await f.compaction(event).catch((e) => e)
		expect(error).toBeInstanceOf(Error)
		expect(error.message).toContain("bad request")
		expect(error.cause).toEqual(FATAL)
		expect(f.created).toHaveLength(1)
		expect(event.result).toBeUndefined()
	})

	test("exhausting the chain throws an Error that preserves the original message and cause", async () => {
		const f = fixture({ reply: () => ({ error: RETRYABLE }) })
		await f.setHandle()
		const event = f.parentEvent()
		const error = await f.compaction(event).catch((e) => e)
		expect(error).toBeInstanceOf(Error)
		expect(error.message).toContain("rate limit exceeded")
		expect(error.cause).toEqual(RETRYABLE)
		expect(f.created.map((c) => c.model?.id)).toEqual(["primary", "backup"])
		expect(event.result).toBeUndefined()
	})

	test("stream loss with no assistant output is not a successful summary", async () => {
		const f = fixture({
			reply: (model) => model === "provider/primary" ? { empty: true } : { text: "backup" },
		})
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(event.result).toMatchObject({ summary: "backup", metadata: { model: "provider/backup", fallback: true } })
	})

	test("an empty output with no remaining chain throws and never sets a result", async () => {
		const f = fixture({ reply: () => ({ empty: true }) })
		await f.setHandle()
		const event = f.parentEvent()
		await expect(f.compaction(event)).rejects.toBeInstanceOf(Error)
		expect(event.result).toBeUndefined()
	})

	test("first-token timeout aborts the original child when a fallback can advance", async () => {
		const f = fixture({
			timeout: 0.02,
			reply: (model) => model === "provider/primary" ? { hang: true } : { text: "backup" },
		})
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(f.trace).toContain("interrupt:child-1")
		expect(event.result).toMatchObject({ summary: "backup", metadata: { model: "provider/backup" } })
	})

	test("first-token timeout does not abort a slow healthy attempt when no fallback can advance", async () => {
		const f = fixture({
			chain: ["provider/primary"],
			timeout: 0.01,
			reply: () => ({ text: "slow but healthy", delayMs: 40 }),
		})
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(f.trace.some((entry) => entry.startsWith("interrupt:"))).toBe(false)
		expect(f.created).toHaveLength(1)
		expect(event.result).toMatchObject({ summary: "slow but healthy", metadata: { model: "provider/primary", fallback: false } })
	})

	test("a text delta before the timeout keeps the original attempt", async () => {
		const f = fixture({
			timeout: 0.05,
			reply: () => ({ text: "late", delta: true }),
		})
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(f.created).toHaveLength(1)
		expect(event.result).toMatchObject({ summary: "late", metadata: { fallback: false } })
	})

	test("cancellation during chain resolution prevents child creation and any result", async () => {
		const gate = defer()
		const f = fixture({ chainGate: gate.promise })
		const installed = await f.setHandle()
		const event = f.parentEvent()
		const run = f.compaction(event)
		await tick()
		installed.cancel("parent")
		gate.resolve()
		await expect(run).rejects.toBeDefined()
		expect(f.created).toHaveLength(0)
		expect(event.result).toBeUndefined()
	})

	test("dispose during chain resolution prevents child creation and any result", async () => {
		const gate = defer()
		const f = fixture({ chainGate: gate.promise })
		const installed = await f.setHandle()
		const event = f.parentEvent()
		const run = f.compaction(event)
		await tick()
		const disposed = installed.dispose()
		gate.resolve()
		await disposed
		// Soft cancel: native compaction runs, so the hook resolves without a result.
		await expect(run).resolves.toBeUndefined()
		expect(f.created).toHaveLength(0)
		expect(event.result).toBeUndefined()
	})

	test("prompt admission racing cancellation settles before the child is reinterrupted and removed", async () => {
		const gate = defer()
		const f = fixture({ promptGate: gate.promise, reply: () => ({ text: "x" }) })
		const installed = await f.setHandle()
		const run = f.compaction(f.parentEvent())
		await tick()
		installed.cancel("parent")
		gate.resolve()
		await expect(run).rejects.toBeDefined()
		expect(f.trace.slice(-3)).toEqual(["prompt-settled:child-1", "interrupt:child-1", "remove:child-1"])
	})

	test("create admission racing cancellation is interrupted and removed before the hook settles", async () => {
		const gate = defer()
		const f = fixture({ createGate: gate.promise })
		const installed = await f.setHandle()
		const event = f.parentEvent()
		const run = f.compaction(event)
		await tick()
		installed.cancel("parent")
		gate.resolve()
		await expect(run).rejects.toBeDefined()
		expect(f.trace).not.toContain("prompt:child-1")
		expect(f.trace).toEqual(["create:child-1", "interrupt:child-1", "remove:child-1"])
		expect(event.result).toBeUndefined()
	})

	test("a child whose context hook was not applied never yields output, and the chain advances", async () => {
		const f = fixture({
			reply: (model) => model === "provider/primary" ? { text: "unscoped", skipContext: true } : { text: "backup" },
		})
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(event.result).toMatchObject({ summary: "backup", metadata: { model: "provider/backup", fallback: true } })
	})

	test("an unscoped child with no remaining chain produces an error, not a summary", async () => {
		const f = fixture({ reply: () => ({ text: "unscoped", skipContext: true }) })
		await f.setHandle()
		const event = f.parentEvent()
		const error = await f.compaction(event).catch((e) => e)
		expect(error).toBeInstanceOf(Error)
		expect(error.message).toMatch(/not scoped/)
		expect(event.result).toBeUndefined()
	})

	test("step failures alone do not abort an attempt that native retry may still recover", async () => {
		const f = fixture({ reply: () => ({ text: "ok", delayMs: 30 }) })
		const installed = await f.setHandle()
		const event = f.parentEvent()
		const run = f.compaction(event)
		await tick()
		installed.handleEvent({ type: "session.step.failed", data: { sessionID: "child-1", assistantMessageID: "m-child-1", error: RETRYABLE } } as never)
		await run
		expect(f.created).toHaveLength(1)
		expect(event.result).toMatchObject({ summary: "ok", metadata: { fallback: false } })
	})

	test("providerState is taken only from the assistant message of the original model", async () => {
		const f = fixture({
			reply: (model) => model === "provider/primary" ? { error: RETRYABLE } : { text: "backup", providerState: { id: "backup-state" } },
		})
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(event.result).toMatchObject({ summary: "backup" })
		expect(event.result?.providerState).toBeUndefined()
	})

	test("text-part provider state is never promoted to message-level providerState", async () => {
		const f = fixture({ reply: () => ({ text: "x", textState: { part: true } }) })
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(event.result?.providerState).toBeUndefined()
	})

	test("a duplicate compaction for the same parent cancels the older run and keeps the newer one", async () => {
		const f = fixture({ reply: (_model, index) => index === 1 ? { hang: true } : { text: "second" } })
		const installed = await f.setHandle()
		const first = f.parentEvent()
		const second = f.parentEvent()
		const a = f.compaction(first)
		await tick()
		const b = f.compaction(second)
		await expect(a).rejects.toBeDefined()
		await expect(b).resolves.toBeUndefined()
		expect(first.result).toBeUndefined()
		expect(second.result).toMatchObject({ summary: "second" })
		expect(f.trace).toContain("interrupt:child-1")
		await installed.dispose()
	})

	test("dispose awaits native cleanup of in-flight runs and tolerates cleanup errors", async () => {
		const f = fixture({ reply: () => ({ hang: true }), removeFails: true })
		const installed = await f.setHandle()
		const run = f.compaction(f.parentEvent())
		await tick()
		await expect(installed.dispose()).resolves.toBeUndefined()
		expect(f.trace).toContain("remove:child-1")
		await expect(run).resolves.toBeUndefined()
	})

	test("cancelAll soft-cancels in-flight runs without a result or error, and later compactions still run", async () => {
		const f = fixture({ reply: (_model, index) => index === 1 ? { hang: true } : { text: "again" } })
		const installed = await f.setHandle()
		const abandoned = f.parentEvent()
		const run = f.compaction(abandoned)
		await tick()
		installed.cancelAll()
		await expect(run).resolves.toBeUndefined()
		expect(abandoned.result).toBeUndefined()
		expect(f.trace).toContain("interrupt:child-1")
		expect(f.trace).toContain("remove:child-1")
		const event = f.parentEvent()
		await f.compaction(event)
		expect(event.result).toMatchObject({ summary: "again" })
	})

	test("only the original child gets the saved options; fallback children keep host-computed options", async () => {
		const host = { maxOutputTokens: 4096, reasoning: { effort: "low" } }
		const f = fixture({
			hostOptions: host,
			reply: (model) => model === "provider/primary" ? { error: RETRYABLE } : { text: "backup" },
		})
		await f.setHandle()
		const original = { thinking: { type: "enabled", budget_tokens: 2000 }, maxOutputTokens: 64000 }
		const event = f.parentEvent({ options: original } as never)
		await f.compaction(event)
		expect(f.requests[0].options).toEqual(original)
		expect(f.requests[1].options).toEqual(host)
		// The saved request is cloned per child, so the fallback never mutates the original's options.
		expect(event.options).toEqual(original)
		expect(event.result).toMatchObject({ summary: "backup", metadata: { fallback: true } })
	})

	test("a hard cancel of the parent session rejects even with the soft cancel path available", async () => {
		const f = fixture({ reply: () => ({ hang: true }) })
		const installed = await f.setHandle()
		const event = f.parentEvent()
		const run = f.compaction(event)
		await tick()
		installed.cancel("parent")
		installed.cancelAll()
		await expect(run).rejects.toBeDefined()
		expect(event.result).toBeUndefined()
	})

	test("an interrupt recorded before this run started is stale and does not cancel it", async () => {
		const f = fixture({ reply: () => ({ hang: true }) })
		const installed = await f.setHandle()
		const run = f.compaction(f.parentEvent())
		await tick()
		installed.handleEvent({ type: "session.execution.interrupted", created: 0, data: { sessionID: "parent", reason: "user" } } as never)
		await tick()
		expect(f.trace).not.toContain("interrupt:child-1")
		installed.cancel("parent")
		await expect(run).rejects.toBeDefined()
	})

	test("an interrupt created after this run started cancels it, and one without a timestamp is treated as current", async () => {
		const f = fixture({ reply: () => ({ hang: true }) })
		const installed = await f.setHandle()
		const first = f.compaction(f.parentEvent())
		await tick()
		installed.handleEvent({ type: "session.execution.interrupted", created: Date.now() + 1000, data: { sessionID: "parent", reason: "user" } } as never)
		await expect(first).rejects.toBeDefined()

		const second = f.compaction(f.parentEvent())
		await tick()
		installed.handleEvent({ type: "session.execution.interrupted", data: { sessionID: "parent", reason: "user" } } as never)
		await expect(second).rejects.toBeDefined()
	})

	test("interception is skipped while the event stream is unhealthy", async () => {
		const f = fixture({ streamHealthy: () => false })
		await f.setHandle()
		const event = f.parentEvent()
		await f.compaction(event)
		expect(f.created).toHaveLength(0)
		expect(event.result).toBeUndefined()
	})

	test("child ids stay internal briefly after removal so late events cannot trigger parent recovery", async () => {
		const f = fixture({ reply: (_model, index) => index === 2 ? { hang: true } : { text: "first" } })
		const installed = await f.setHandle()
		await f.compaction(f.parentEvent())
		expect(installed.isInternal("child-1")).toBe(true)
		expect(installed.isInternal("parent")).toBe(false)

		const next = f.parentEvent()
		const run = f.compaction(next)
		await tick()
		installed.handleEvent({ type: "session.execution.interrupted", data: { sessionID: "child-1", reason: "user" } } as never)
		await tick()
		expect(f.trace).not.toContain("interrupt:child-2")
		installed.cancel("parent")
		await expect(run).rejects.toBeDefined()
	})

	test("a deleted parent drops its fallback cooldown memory", async () => {
		const f = fixture({
			cooldown: 60,
			chain: ["provider/backup", "provider/third"],
			reply: (_model, index) => {
				if (index <= 2) return { error: RETRYABLE }
				if (index === 3) return { text: "third" }
				return index === 4 ? { error: RETRYABLE } : { text: "backup" }
			},
		})
		const installed = await f.setHandle()
		await f.compaction(f.parentEvent())
		installed.handleEvent({ type: "session.deleted", data: { sessionID: "parent" } } as never)
		await f.compaction(f.parentEvent())
		expect(f.created.slice(3).map((c) => c.model?.id)).toEqual(["primary", "backup"])
	})

	test("retry hook disables native retries for live children only when a fallback can advance", async () => {
		const f = fixture({ reply: () => ({ hang: true }) })
		const installed = await f.setHandle()
		const run = f.compaction(f.parentEvent())
		await tick()
		const childRetry = { sessionID: "child-1", agent: "build", model: { id: "primary", providerID: "provider" }, error: RETRYABLE, attempt: 1, decision: { retry: true, delay: 1 } }
		f.retry(childRetry)
		expect(childRetry.decision).toEqual({ retry: false })
		const fatal = { sessionID: "child-1", agent: "build", model: { id: "primary", providerID: "provider" }, error: FATAL, attempt: 1, decision: { retry: true, delay: 1 } }
		f.retry(fatal)
		expect(fatal.decision).toEqual({ retry: true, delay: 1 })
		const parentRetry = { sessionID: "parent", agent: "build", model: { id: "primary", providerID: "provider" }, error: RETRYABLE, attempt: 1, decision: { retry: true, delay: 1 } }
		f.retry(parentRetry)
		expect(parentRetry.decision).toEqual({ retry: true, delay: 1 })
		installed.cancel("parent")
		await expect(run).rejects.toBeDefined()
	})

	test("isInternal recognizes only live temporary children", async () => {
		const f = fixture({ reply: () => ({ hang: true }) })
		const installed = await f.setHandle()
		expect(installed.isInternal("child-1")).toBe(false)
		const run = f.compaction(f.parentEvent())
		await tick()
		expect(installed.isInternal("child-1")).toBe(true)
		expect(installed.isInternal("parent")).toBe(false)
		installed.cancel("parent")
		await expect(run).rejects.toBeDefined()
	})
})
