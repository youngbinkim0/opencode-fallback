import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { installV2ForegroundTaskFallback } from "./v2-foreground-task"
import { RECOVERY_TIMING } from "./v2-background-task"

const DEFAULT_TIMING = { ...RECOVERY_TIMING }
beforeEach(() => Object.assign(RECOVERY_TIMING, { pollMs: 10, graceMs: 60 }))
afterEach(() => Object.assign(RECOVERY_TIMING, DEFAULT_TIMING))

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

async function until(predicate: () => boolean, description: string, timeout = 1000) {
	const start = Date.now()
	while (!predicate()) {
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${description}`)
		await flush()
	}
}

const RUNNING_NATIVE = {
	output: { sessionID: "child", status: "running", output: "" },
	content: '<subagent sessionID="child" state="running">\nRunning in background.\n</subagent>',
	metadata: { sessionID: "child", status: "running" },
}

const completedNative = (output: string) => ({
	output: { sessionID: "child", status: "completed", output },
	content: "",
	metadata: { sessionID: "child", status: "completed" },
})

const MSG_ID = /^msg_[0-9a-f]{32}$/

let directoryCounter = 0

function harness(options: {
	run?: (input: any, context: any) => Promise<unknown>
	owned?: (sessionID: string) => boolean
	cancelled?: (sessionID: string) => boolean
	waitForFallback?: (sessionID: string, signal: AbortSignal) => Promise<string | undefined>
	info?: () => unknown
	messages?: unknown[]
	directory?: string
	synthetic?: (input: any) => Promise<unknown>
}) {
	const directory = options.directory ?? `/tmp/opencode-fallback-test-${++directoryCounter}-${Math.random()}`
	const nativeInputs: any[] = []
	const nativeContexts: any[] = []
	const parentProgress: unknown[] = []
	const synthetic: any[] = []
	const interrupts: any[] = []
	const cancels: string[] = []
	const parent = new AbortController()
	const native = {
		id: "subagent",
		name: "subagent",
		description: "Native subagent",
		input: {},
		output: {},
		async execute(input: any, context: any) {
			nativeInputs.push(input)
			nativeContexts.push(context)
			return (options.run ?? (async () => new Promise(() => {})))(input, context)
		},
	}
	const ctx = {
		location: { directory },
		tool: {
			async transform(callback: (editor: any) => void) {
				callback({
					list: () => [native],
					update(id: string, update: (tool: any) => void) {
						if (id === "subagent") update(native)
					},
				})
				return { dispose: async () => {} }
			},
		},
		session: {
			async synthetic(input: any) {
				synthetic.push(input)
				if (options.synthetic) return options.synthetic(input)
				return { id: "x" }
			},
			async interrupt(input: { sessionID: string }) {
				interrupts.push(input)
				return { interrupted: true }
			},
			async get() {
				return options.info?.() ?? { outcome: undefined, time: { created: 0, updated: 0 } }
			},
			async context() { return options.messages ?? [] },
		},
	} as unknown as Plugin.Context
	const install = installV2ForegroundTaskFallback(ctx, {
		cancelFallback(sessionID) { cancels.push(sessionID) },
		ownsFallback(sessionID) { return options.owned?.(sessionID) ?? false },
		isCancelled(sessionID) { return options.cancelled?.(sessionID) ?? false },
		async waitForFallback(sessionID, signal) {
			return options.waitForFallback?.(sessionID, signal)
		},
	})
	const context = {
		sessionID: "parent",
		agent: "build",
		messageID: "message",
		id: "call-1",
		signal: parent.signal,
		async progress(value: unknown) { parentProgress.push(value) },
	}
	return {
		directory,
		install,
		nativeInputs, nativeContexts, parentProgress, synthetic, interrupts, cancels,
		parent, context,
		async run(input: any) {
			const registration = await install
			return { registration, result: (native.execute as (input: any, context: any) => Promise<unknown>)(input, context) }
		},
	}
}

const backgroundInput = () => ({ agent: "explore", description: "Read docs", prompt: "Read the docs", background: true })

describe("v2 background subagent fallback delivery", () => {
	test("a new binding present before native rejection reads recovered history instead of reporting the old failure", async () => {
		const failed = deferred<void>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await failed.promise
				throw new Error("429 Too Many Requests")
			},
			owned: () => true,
		})
		const { result, registration } = await old.run(backgroundInput())
		await result
		await registration.dispose()
		const fresh = harness({
			directory: old.directory,
			info: () => ({ outcome: "succeeded", time: { idle: Date.now(), updated: Date.now() } }),
			messages: [{ type: "assistant", content: [{ type: "text", text: "recovered history" }] }],
		})
		await fresh.install
		failed.resolve()
		await until(() => fresh.synthetic.length === 1, "recovered outcome")
		expect(fresh.synthetic[0].metadata.state).toBe("completed")
		expect(old.synthetic).toHaveLength(0)
	})
	test("user cancellation during owned recovery replaces the original provider error with cancelled", async () => {
		const failed = deferred<void>()
		const recovered = deferred<string | undefined>()
		let cancelled = false
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await failed.promise
				throw new Error("429 Too Many Requests")
			},
			owned: () => true,
			cancelled: () => cancelled,
			waitForFallback: () => recovered.promise,
		})
		await (await h.run(backgroundInput())).result
		failed.resolve()
		await flush()
		cancelled = true
		recovered.resolve(undefined)
		await until(() => h.synthetic.length === 1, "cancelled outcome")
		expect(h.synthetic[0].metadata.state).toBe("cancelled")
		expect(h.synthetic[0].text).not.toContain("429")
	})
	test("returns a running result while the child is unresolved and passes background=false to native", async () => {
		const childDone = deferred<unknown>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child", status: "running" })
				return childDone.promise
			},
		})
		const input = backgroundInput()
		const { result } = await h.run(input)
		expect(await result).toEqual({
			...RUNNING_NATIVE,
			content: '<subagent sessionID="child" state="running" description="Read docs">\nRunning in background.\n</subagent>',
		})
		expect(h.nativeInputs).toHaveLength(1)
		expect(h.nativeInputs[0]).toEqual({ ...input, background: false })
		expect(h.synthetic).toEqual([])
		childDone.resolve(undefined)
	})

	test("does not mutate the caller input and keeps native session context", async () => {
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return new Promise(() => {})
			},
		})
		const input = backgroundInput()
		const snapshot = structuredClone(input)
		await h.run(input)
		expect(input).toEqual(snapshot)
		expect(h.nativeInputs[0]).not.toBe(input)
		expect(h.nativeContexts[0]).toMatchObject({ sessionID: "parent", agent: "build", messageID: "message" })
		expect(h.nativeContexts[0].signal).not.toBe(h.context.signal)
		expect(h.nativeContexts[0].signal.aborted).toBe(false)
	})

	test("preserves a native error that happens before the child session is reported", async () => {
		const permission = new Error("Permission denied for subagent")
		const h = harness({ async run() { throw permission } })
		const { result } = await h.run(backgroundInput())
		await expect(result).rejects.toBe(permission)
		await flush()
		expect(h.synthetic).toEqual([])
		expect(h.parentProgress).toEqual([])
	})

	test("parent completion after handoff does not cancel the detached child", async () => {
		const childDone = deferred<unknown>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return childDone.promise
			},
		})
		const { result } = await h.run(backgroundInput())
		await result
		h.parent.abort()
		await flush()
		expect(h.nativeContexts[0].signal.aborted).toBe(false)
		expect(h.interrupts).toEqual([])
		expect(h.cancels).toEqual([])
		childDone.resolve(completedNative("late answer"))
		await until(() => h.synthetic.length === 1, "completed notification")
		expect(h.synthetic[0].text).toBe('<subagent sessionID="child" state="completed" description="Read docs">\nlate answer\n</subagent>')
	})

	test("does not forward native progress to the parent after handoff", async () => {
		const later = deferred<void>()
		const finish = deferred<unknown>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await later.promise
				await context.progress({ status: "after-handoff" })
				return finish.promise
			},
		})
		await (await h.run(backgroundInput())).result
		later.resolve()
		await flush()
		expect(h.parentProgress).toEqual([{ sessionID: "child" }])
		finish.resolve(undefined)
	})

	test("owned native retry failure waits for fallback and emits exactly one completed notification", async () => {
		const childFailed = deferred<void>()
		const fallback = deferred<string | undefined>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => fallback.promise,
		})
		const { result } = await h.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		expect(h.synthetic).toEqual([])
		fallback.resolve("recovered answer")
		await until(() => h.synthetic.length === 1, "completed notification")
		await flush()
		expect(h.synthetic).toHaveLength(1)
		expect(h.synthetic[0]).toMatchObject({
			sessionID: "parent",
			text: '<subagent sessionID="child" state="completed" description="Read docs">\nrecovered answer\n</subagent>',
			resume: true,
			metadata: { source: "subagent", childID: "child", agent: "explore", state: "completed", "opencode-fallback": true },
		})
	})

	test("unowned native error emits exactly one error notification with the native message", async () => {
		const childFailed = deferred<void>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Native exploded (sessionID: child)")
			},
			owned: () => false,
		})
		await (await h.run(backgroundInput())).result
		childFailed.resolve()
		await until(() => h.synthetic.length === 1, "error notification")
		await flush()
		expect(h.synthetic).toHaveLength(1)
		expect(h.synthetic[0]).toMatchObject({
			text: '<subagent sessionID="child" state="error" description="Read docs">\nNative exploded (sessionID: child)\n</subagent>',
			metadata: { source: "subagent", childID: "child", agent: "explore", state: "error", "opencode-fallback": true },
		})
	})

	test("owned fallback that cannot recover emits one error notification", async () => {
		const childFailed = deferred<void>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Exhausted (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: async () => undefined,
		})
		await (await h.run(backgroundInput())).result
		childFailed.resolve()
		await until(() => h.synthetic.length === 1, "error notification")
		await flush()
		expect(h.synthetic).toHaveLength(1)
		expect(h.synthetic[0].metadata.state).toBe("error")
	})

	test("parent cancel before handoff aborts native and emits no notification", async () => {
		const gate = deferred<void>()
		const h = harness({
			async run(_input, context) {
				await gate.promise
				// Late progress after the parent was cancelled: the child must be stopped.
				await context.progress({ sessionID: "child" })
				throw new Error("Native cancelled")
			},
			owned: () => true,
		})
		const { result } = await h.run(backgroundInput())
		h.parent.abort()
		gate.resolve()
		await expect(result).rejects.toThrow("Native cancelled")
		await flush()
		expect(h.nativeContexts[0].signal.aborted).toBe(true)
		expect(h.cancels).toEqual(["child"])
		expect(h.interrupts).toEqual([{ sessionID: "child", resume: false }])
		expect(h.synthetic).toEqual([])
	})

	test("native promotion that resolves running does not emit a duplicate notification", async () => {
		const promoted = deferred<unknown>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return promoted.promise
			},
			owned: () => false,
		})
		await (await h.run(backgroundInput())).result
		promoted.resolve(RUNNING_NATIVE)
		await flush()
		await flush()
		expect(h.synthetic).toEqual([])
	})

	test("escapes the description attribute in the completion notification", async () => {
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return completedNative("ok")
			},
		})
		await (await h.run({ ...backgroundInput(), description: `A "B" <C> & 'D'` })).result
		await until(() => h.synthetic.length === 1, "completed notification")
		expect(h.synthetic[0].text).toBe(
			'<subagent sessionID="child" state="completed" description="A &quot;B&quot; &lt;C&gt; &amp; &apos;D&apos;">\nok\n</subagent>',
		)
	})

	test("each background call gets its own msg_ notification id, even when resuming the same child", async () => {
		let calls = 0
		const h = harness({
			async run(_input, context) {
				calls++
				await context.progress({ sessionID: "child" })
				return completedNative(`answer ${calls}`)
			},
		})
		await (await h.run(backgroundInput())).result
		await (await h.run({ ...backgroundInput(), task_id: "child" })).result
		await until(() => h.synthetic.length === 2, "two completed notifications")
		await flush()
		expect(h.synthetic).toHaveLength(2)
		expect(h.synthetic[0].id).toMatch(MSG_ID)
		expect(h.synthetic[1].id).toMatch(MSG_ID)
		expect(h.synthetic[0].id).not.toBe(h.synthetic[1].id)
		expect(h.synthetic[0].text).toContain("answer 1")
		expect(h.synthetic[1].text).toContain("answer 2")
	})

	test("post-handoff user interrupt of an unowned child is reported as cancelled, not error", async () => {
		const childStopped = deferred<void>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childStopped.promise
				throw new DOMException("This operation was aborted", "AbortError")
			},
			owned: () => false,
		})
		await (await h.run(backgroundInput())).result
		childStopped.resolve()
		await until(() => h.synthetic.length === 1, "cancelled notification")
		await flush()
		expect(h.synthetic).toHaveLength(1)
		expect(h.synthetic[0].metadata.state).toBe("cancelled")
		expect(h.synthetic[0].text).toBe('<subagent sessionID="child" state="cancelled" description="Read docs">\nSubagent cancelled.\n</subagent>')
		expect(h.interrupts).toEqual([])
	})

	test("native 'Subagent cancelled' error after handoff is cancelled when the child is unowned", async () => {
		const childStopped = deferred<void>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childStopped.promise
				throw new Error("Subagent cancelled (sessionID: child)")
			},
			owned: () => false,
		})
		await (await h.run(backgroundInput())).result
		childStopped.resolve()
		await until(() => h.synthetic.length === 1, "cancelled notification")
		await flush()
		expect(h.synthetic).toHaveLength(1)
		expect(h.synthetic[0].metadata.state).toBe("cancelled")
	})

	test("native cancellation of an owned child still waits for fallback and reports its output", async () => {
		const childStopped = deferred<void>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childStopped.promise
				throw new Error("Subagent cancelled (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: async () => "recovered after cancel",
		})
		await (await h.run(backgroundInput())).result
		childStopped.resolve()
		await until(() => h.synthetic.length === 1, "completed notification")
		expect(h.synthetic[0].metadata.state).toBe("completed")
		expect(h.synthetic[0].text).toContain("recovered after cancel")
	})

	test("disposal does not emit a false error, duplicate, or cancel the child", async () => {
		const childFailed = deferred<void>()
		const fallback = deferred<string | undefined>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => fallback.promise,
		})
		const { registration, result } = await h.run(backgroundInput())
		await result
		await registration.dispose()
		childFailed.resolve()
		fallback.resolve(undefined)
		await flush()
		await flush()
		expect(h.synthetic).toEqual([])
		expect(h.interrupts).toEqual([])
		expect(h.cancels).toEqual([])
	})

	test("disposal holds a completed result until a new binding delivers it exactly once", async () => {
		const childDone = deferred<unknown>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return childDone.promise
			},
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		await registration.dispose()
		childDone.resolve(completedNative("done"))
		await flush()
		await flush()
		expect(old.synthetic).toEqual([])
		const fresh = harness({ directory: old.directory })
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "delivery after rebinding")
		await flush()
		expect(fresh.synthetic).toHaveLength(1)
		expect(fresh.synthetic[0].metadata.state).toBe("completed")
		expect(fresh.synthetic[0].text).toContain("done")
		expect(old.synthetic).toEqual([])
	})

	test("reload during a pending owned wait hands the wait to the new instance and delivers once", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		// The disposed V2 owner returns undefined from its wait.
		gone.resolve(undefined)
		await flush()
		expect(old.synthetic).toEqual([])

		const fresh = harness({
			directory: old.directory,
			owned: () => true,
			waitForFallback: async () => "recovered after reload",
		})
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "reload completion")
		await flush()
		expect(fresh.synthetic).toHaveLength(1)
		expect(fresh.synthetic[0].text).toBe('<subagent sessionID="child" state="completed" description="Read docs">\nrecovered after reload\n</subagent>')
		expect(old.synthetic).toEqual([])
		expect(old.interrupts).toEqual([])
		expect(fresh.interrupts).toEqual([])
	})

	test("reload with a new instance that does not own the child reads the terminal success from session history", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		gone.resolve(undefined)

		const fresh = harness({
			directory: old.directory,
			owned: () => false,
			info: () => ({ outcome: "succeeded", time: { created: 0, updated: 0, idle: 2 } }),
			messages: [{ type: "assistant", error: undefined, content: [{ type: "text", text: "answer from history" }] }],
		})
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "history completion", 3000)
		expect(fresh.synthetic[0].text).toContain("answer from history")
		expect(fresh.synthetic[0].metadata.state).toBe("completed")
	})

	test("an interrupted outcome after reload is not reported as failure; the terminal success is", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		gone.resolve(undefined)

		let polls = 0
		const fresh = harness({
			directory: old.directory,
			owned: () => false,
			info: () => (++polls === 1
				? { outcome: "interrupted", time: { created: 0, updated: 0, idle: 1 } }
				: { outcome: "succeeded", time: { created: 0, updated: 0, idle: 2 } }),
			messages: [{ type: "assistant", error: undefined, content: [{ type: "text", text: "continued answer" }] }],
		})
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "continued completion", 5000)
		expect(polls).toBeGreaterThanOrEqual(2)
		expect(fresh.synthetic).toHaveLength(1)
		expect(fresh.synthetic[0].metadata.state).toBe("completed")
		expect(fresh.synthetic[0].text).toContain("continued answer")
	})

	test("a failed terminal outcome in the new generation reports one error with the native message", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		gone.resolve(undefined)

		const fresh = harness({
			directory: old.directory,
			owned: () => false,
			info: () => ({ outcome: "failed", time: { created: 0, updated: 0, idle: 3 } }),
		})
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "failed notification")
		await flush()
		expect(fresh.synthetic).toHaveLength(1)
		expect(fresh.synthetic[0].text).toBe('<subagent sessionID="child" state="error" description="Read docs">\nRate limited (sessionID: child)\n</subagent>')
	})

	test("omits description from the synthetic when the background call has none", async () => {
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return completedNative("no description")
			},
		})
		await (await h.run({ agent: "explore", prompt: "Read the docs", background: true })).result
		await until(() => h.synthetic.length === 1, "completed notification")
		expect("description" in h.synthetic[0]).toBe(false)
		expect(h.synthetic[0].text).toBe('<subagent sessionID="child" state="completed" description="">\nno description\n</subagent>')
	})

	test("native context exposes only progress as a callback and keeps the parent call identity", async () => {
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return new Promise(() => {})
			},
		})
		await h.run(backgroundInput())
		const received = h.nativeContexts[0]
		const callbacks = Object.entries(received).filter(([, value]) => typeof value === "function").map(([key]) => key)
		expect(callbacks).toEqual(["progress"])
		expect(Object.keys(received).sort()).toEqual(["agent", "id", "messageID", "progress", "sessionID", "signal"])
		expect(received).toMatchObject({ sessionID: "parent", agent: "build", messageID: "message", id: "call-1" })
	})

	test("a delivery that fails on a disposed lease is retried on rebind with the same id", async () => {
		const childDone = deferred<unknown>()
		let disposeOld: (() => Promise<void>) | undefined
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return childDone.promise
			},
			// The reload lands during the delivery call: the host rejects it.
			async synthetic() {
				await disposeOld?.()
				throw new Error("Session disposed")
			},
		})
		const { registration, result } = await old.run(backgroundInput())
		disposeOld = () => registration.dispose()
		await result
		childDone.resolve(completedNative("delivered once"))
		await until(() => old.synthetic.length === 1, "first delivery attempt")
		const fresh = harness({ directory: old.directory })
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "retried delivery")
		await flush()
		expect(fresh.synthetic).toHaveLength(1)
		expect(fresh.synthetic[0].id).toBe(old.synthetic[0].id)
		expect(fresh.synthetic[0].text).toContain("delivered once")
	})

	test("a ConflictError on delivery means an earlier attempt committed, so it is not retried", async () => {
		const childDone = deferred<unknown>()
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return childDone.promise
			},
			async synthetic() {
				throw Object.assign(new Error("Conflict"), { _tag: "ConflictError" })
			},
		})
		await (await h.run(backgroundInput())).result
		childDone.resolve(completedNative("committed earlier"))
		await until(() => h.synthetic.length === 1, "delivery attempt")
		await flush()
		await new Promise((resolve) => setTimeout(resolve, 60))
		expect(h.synthetic).toHaveLength(1)
	})

	test("a transient delivery failure on a live lease retries with the same id", async () => {
		const childDone = deferred<unknown>()
		let calls = 0
		const h = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				return childDone.promise
			},
			async synthetic() {
				if (++calls === 1) throw new Error("Transient network error")
				return { id: "x" }
			},
		})
		await (await h.run(backgroundInput())).result
		childDone.resolve(completedNative("retried"))
		await until(() => h.synthetic.length === 2, "retried delivery")
		expect(h.synthetic[0].id).toBe(h.synthetic[1].id)
		expect(h.synthetic[1].text).toContain("retried")
	})

	test("an owned wait that rejects because its lease was released rebinds instead of reporting an error", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		// The released V2 owner rejects its pending wait rather than resolving undefined.
		gone.reject(new Error("Owner disposed"))
		await flush()
		expect(old.synthetic).toEqual([])
		const fresh = harness({ directory: old.directory, owned: () => true, waitForFallback: async () => "recovered despite rejection" })
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "recovered completion")
		expect(fresh.synthetic[0].text).toContain("recovered despite rejection")
		expect(fresh.synthetic[0].metadata.state).toBe("completed")
	})

	test("a session.get failure on a released lease rebinds, and the next generation still delivers", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		gone.resolve(undefined)

		let polls = 0
		const middle = harness({
			directory: old.directory,
			owned: () => false,
			info: () => {
				if (++polls === 1) throw new Error("session.get unavailable")
				return { outcome: "succeeded", time: { created: 0, updated: 0, idle: 2 } }
			},
			messages: [{ type: "assistant", error: undefined, content: [{ type: "text", text: "from the next generation" }] }],
		})
		const middleRegistration = await middle.install
		// The first poll fails after this generation is released by a reload.
		await until(() => polls >= 1, "first poll")
		await middleRegistration.dispose()
		const fresh = harness({
			directory: old.directory,
			owned: () => false,
			info: () => ({ outcome: "succeeded", time: { created: 0, updated: 0, idle: 3 } }),
			messages: [{ type: "assistant", error: undefined, content: [{ type: "text", text: "from the next generation" }] }],
		})
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "delivery after second reload", 3000)
		expect(fresh.synthetic[0].text).toContain("from the next generation")
		expect(middle.synthetic).toEqual([])
	})

	test("an interrupted child that is never continued resolves as cancelled after a bounded grace", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		gone.resolve(undefined)

		const fresh = harness({
			directory: old.directory,
			owned: () => false,
			info: () => ({ outcome: "interrupted", time: { created: 0, updated: 5, idle: 4 } }),
		})
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "bounded cancellation", 3000)
		await flush()
		expect(fresh.synthetic).toHaveLength(1)
		expect(fresh.synthetic[0].metadata.state).toBe("cancelled")
		expect(fresh.synthetic[0].text).toBe('<subagent sessionID="child" state="cancelled" description="Read docs">\nSubagent cancelled.\n</subagent>')
		expect(fresh.interrupts).toEqual([])
	})

	test("a stale failed outcome is not terminal while a continuation advances the session", async () => {
		const childFailed = deferred<void>()
		const gone = deferred<string | undefined>()
		const old = harness({
			async run(_input, context) {
				await context.progress({ sessionID: "child" })
				await childFailed.promise
				throw new Error("Rate limited (sessionID: child)")
			},
			owned: () => true,
			waitForFallback: () => gone.promise,
		})
		const { registration, result } = await old.run(backgroundInput())
		await result
		childFailed.resolve()
		await flush()
		await registration.dispose()
		gone.resolve(undefined)

		const steps = [
			{ outcome: "failed", time: { created: 0, updated: 1, idle: 1 } },
			// The continuation was admitted and started running.
			{ outcome: undefined, time: { created: 0, updated: 2 } },
			{ outcome: undefined, time: { created: 0, updated: 3 } },
			{ outcome: "succeeded", time: { created: 0, updated: 4, idle: 4 } },
		]
		let step = 0
		const fresh = harness({
			directory: old.directory,
			owned: () => false,
			info: () => steps[Math.min(step++, steps.length - 1)],
			messages: [{ type: "assistant", error: undefined, content: [{ type: "text", text: "continued and finished" }] }],
		})
		await fresh.install
		await until(() => fresh.synthetic.length === 1, "continued completion", 3000)
		expect(fresh.synthetic[0].metadata.state).toBe("completed")
		expect(fresh.synthetic[0].text).toContain("continued and finished")
	})
})
