import type { Plugin } from "@opencode/plugin"
import type { V2ForegroundTaskFallback } from "./v2-foreground-task"
import { logError } from "./logger"

/** Captured by this imported module, rather than inferred from files on disk. */
export const BACKGROUND_RUNTIME = Object.freeze({ revision: "final-outcome-v2", moduleID: crypto.randomUUID() })

export type NativeSubagentOutput = {
	sessionID: string
	status: "completed" | "running"
	output: string
}

export type NativeToolResult = {
	output: NativeSubagentOutput
	content: string
	metadata: { sessionID: string; status: "completed" | "running" }
}

export type NativeToolContext = {
	sessionID: string
	signal: AbortSignal
	progress: (update: Record<string, unknown>) => Promise<void>
}

export type NativeTool = {
	execute: (input: unknown, context: NativeToolContext) => Promise<unknown>
}

type Finished =
	| { state: "completed"; output: string }
	| { state: "error"; message: string }
	| { state: "cancelled" }

/**
 * Recovery timing. `pollMs` is the interval between session-history checks for a
 * reloaded child. `graceMs` is how long an unchanged `interrupted` or `failed`
 * outcome must persist before it is treated as terminal; an admitted continuation
 * changes the session timestamps and restarts the window.
 */
export const RECOVERY_TIMING = { pollMs: 1000, graceMs: 30_000 }
const MAX_DELIVERY_FAILURES = 5

/**
 * One binding of the plugin generation to a location. A reload binds a new lease
 * and ends the old one; pending background jobs rebind to whichever lease is
 * active, so their notification and recovery use the latest context.
 */
type BackgroundLease = {
	readonly ctx: Plugin.Context
	readonly coordination: V2ForegroundTaskFallback
	active: boolean
	readonly ended: Promise<void>
	end(): void
}

type BackgroundManager = { lease?: BackgroundLease; waiters: Set<() => void> }

const REGISTRY = Symbol.for("opencode-fallback.v2.background-jobs")

function managerFor(ctx: Plugin.Context): BackgroundManager {
	const registry = globalThis as unknown as Record<symbol, Map<string, BackgroundManager> | undefined>
	const managers = (registry[REGISTRY] ??= new Map())
	const key = JSON.stringify([ctx.location.directory, ctx.location.workspaceID ?? null])
	let manager = managers.get(key)
	if (!manager) {
		manager = { waiters: new Set() }
		managers.set(key, manager)
	}
	return manager
}

function wake(manager: BackgroundManager) {
	const waiters = [...manager.waiters]
	manager.waiters.clear()
	for (const resolve of waiters) resolve()
}

async function currentLease(manager: BackgroundManager): Promise<BackgroundLease> {
	for (;;) {
		const lease = manager.lease
		if (lease?.active) return lease
		await new Promise<void>((resolve) => manager.waiters.add(resolve))
	}
}

/**
 * Bind this plugin generation as the latest context for its location. Returns a
 * release function for registration disposal. Release never cancels any child;
 * it only lets pending jobs wait for the next binding.
 */
export function createBackgroundLease(ctx: Plugin.Context, coordination: V2ForegroundTaskFallback): () => void {
	const manager = managerFor(ctx)
	manager.lease?.end()
	let endLease!: () => void
	const ended = new Promise<void>((resolve) => { endLease = resolve })
	const lease: BackgroundLease = {
		ctx,
		coordination,
		active: true,
		ended,
		end() {
			lease.active = false
			endLease()
		},
	}
	manager.lease = lease
	wake(manager)
	return () => {
		if (manager.lease === lease) manager.lease = undefined
		lease.end()
	}
}

/**
 * Start a native `subagent` call as a background job while the foreground
 * native run keeps owning permissions, nesting, agent selection, and child
 * creation. The parent receives a running result as soon as the child session
 * is reported. The final outcome (after any owned fallback) is delivered as one
 * synthetic message to the parent, using the latest binding for the location.
 */
export async function startBackgroundSubagent(
	ctx: Plugin.Context,
	coordination: V2ForegroundTaskFallback,
	native: NativeTool,
	input: unknown,
	context: NativeToolContext,
): Promise<unknown> {
	const manager = managerFor(ctx)
	const origin = manager.lease
	const detached = new AbortController()
	let childSessionID: string | undefined
	let handedOff = false
	let resolveStarted!: (sessionID: string) => void
	const started = new Promise<string>((resolve) => { resolveStarted = resolve })

	const nativeRun = native.execute(
		{ ...(input as Record<string, unknown> | undefined), background: false },
		{
			...context,
			signal: detached.signal,
			async progress(update) {
				if (typeof update.sessionID === "string" && !childSessionID) {
					childSessionID = update.sessionID
					resolveStarted(update.sessionID)
				}
				// The parent tool call closes at handoff, so later native updates are dropped.
				if (!handedOff && !context.signal.aborted) await context.progress(update)
			},
		},
	)
	// Observed by the handoff race or the background worker. Attaching now keeps
	// a pre-handoff rejection from surfacing as an unhandled rejection.
	nativeRun.catch(() => {})
	const settled = nativeRun.then(() => undefined, () => undefined)

	let onParentAbort: () => void = () => {}
	const parentAborted = new Promise<"aborted">((resolve) => {
		onParentAbort = () => resolve("aborted")
	})
	if (context.signal.aborted) onParentAbort()
	else context.signal.addEventListener("abort", onParentAbort, { once: true })

	const handoff = await Promise.race([
		started.then((sessionID) => ({ kind: "started" as const, sessionID })),
		settled.then(() => ({ kind: "settled" as const })),
		parentAborted.then(() => ({ kind: "aborted" as const })),
	])
	context.signal.removeEventListener("abort", onParentAbort)

	if (handoff.kind === "settled") return nativeRun

	if (handoff.kind === "aborted" || context.signal.aborted) {
		// The parent is gone before a running result exists. Stop the native run
		// and any child it reports while tearing down.
		detached.abort()
		await settled
		if (childSessionID) cancelChild(ctx, coordination, childSessionID)
		const failure = await nativeRun.then(() => undefined, (error: unknown) => ({ error }))
		if (failure) throw failure.error
		throw new DOMException("Subagent cancelled", "AbortError")
	}

	handedOff = true
	const child = handoff.sessionID
	const description = stringField(input, "description")
	const agent = stringField(input, "agent") ?? null
	// One notification per background call: resuming the same child notifies again.
	const notificationID = `msg_${crypto.randomUUID().replace(/-/g, "")}`
	void deliverOutcome(manager, { parentID: context.sessionID, nativeRun, child, detached, description, agent, notificationID, origin })

	const attrs = `sessionID="${child}" state="running" description="${escapeXMLAttribute(description ?? "")}"`
	return {
		output: { sessionID: child, status: "running", output: "" },
		content: `<subagent ${attrs}>\nRunning in background.\n</subagent>`,
		metadata: { sessionID: child, status: "running" },
	} satisfies NativeToolResult
}

/**
 * Escape a value for a double-quoted XML attribute in the subagent envelope.
 */
export function escapeXMLAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
}

/**
 * Read the latest non-error assistant text from the supported V2 session
 * context API. Used after an owned child has reached success.
 */
export async function readV2ForegroundSubagentOutput(
	ctx: Plugin.Context,
	sessionID: string,
): Promise<string | undefined> {
	const messages = await ctx.session.context({ sessionID })
	for (const message of [...messages].reverse()) {
		if (message.type !== "assistant") continue
		if (message.error) return
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
		return text.trim() ? text : undefined
	}
	return undefined
}

function stringField(input: unknown, key: string): string | undefined {
	const value = (input as Record<string, unknown> | undefined)?.[key]
	return typeof value === "string" ? value : undefined
}

function cancelChild(ctx: Plugin.Context, coordination: V2ForegroundTaskFallback, child: string) {
	coordination.cancelFallback(child)
	void ctx.session.interrupt({ sessionID: child, resume: false }).catch(() => {})
}

/**
 * Narrow classification of a native user abort after handoff. The detached
 * signal is never aborted after handoff, so these errors come from the native run.
 */
function isNativeCancellation(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true
	return error instanceof Error && /^Subagent cancelled\b/.test(error.message)
}

async function deliverOutcome(
	manager: BackgroundManager,
	options: {
		parentID: string
		nativeRun: Promise<unknown>
		child: string
		detached: AbortController
		description: string | undefined
		agent: string | null
		notificationID: string
		origin: BackgroundLease | undefined
	},
): Promise<void> {
	const { parentID, nativeRun, child, detached, description, agent, notificationID } = options
	try {
		const finished = await finalOutcome(manager, nativeRun, child, detached.signal, options.origin)
		// Native promotion owns its own completion notification.
		if (!finished) return
		const state = finished.state
		const body = finished.state === "completed" ? finished.output : finished.state === "error" ? finished.message : "Subagent cancelled."
		const attrs = `sessionID="${child}" state="${state}" description="${escapeXMLAttribute(description ?? "")}"`
		await deliver(manager, {
			sessionID: parentID,
			id: notificationID as never,
			text: `<subagent ${attrs}>\n${body}\n</subagent>`,
			// The host accepts an optional string here, not null: omit when absent.
			...(description !== undefined ? { description } : {}),
			metadata: { source: "subagent", childID: child, agent, state, "opencode-fallback": true },
			resume: true,
		})
	} catch (error) {
		logError("V2 background subagent notification failed", { sessionID: child, error: String(error) })
	}
}

type SyntheticInput = Parameters<Plugin.Context["session"]["synthetic"]>[0]

/**
 * Deliver one notification with a fixed id. A failure on a released lease rebinds
 * and retries with the same id. A failure on a live lease is retried a bounded
 * number of times. ConflictError means an earlier attempt already committed.
 */
async function deliver(manager: BackgroundManager, input: SyntheticInput): Promise<void> {
	let liveFailures = 0
	for (;;) {
		const lease = await currentLease(manager)
		try {
			await lease.ctx.session.synthetic(input)
			return
		} catch (error) {
			if ((error as { _tag?: unknown } | undefined)?._tag === "ConflictError") return
			if (!lease.active) continue
			liveFailures++
			if (liveFailures >= MAX_DELIVERY_FAILURES) throw error
			await new Promise((resolve) => setTimeout(resolve, RECOVERY_TIMING.pollMs))
		}
	}
}

async function finalOutcome(
	manager: BackgroundManager,
	nativeRun: Promise<unknown>,
	child: string,
	signal: AbortSignal,
	origin: BackgroundLease | undefined,
): Promise<Finished | undefined> {
	let nativeError: unknown
	try {
		const native = (await nativeRun) as NativeToolResult | undefined
		if (native?.output?.status === "running") return undefined
		return { state: "completed", output: native?.output?.output ?? "" }
	} catch (error) {
		nativeError = error
	}
	const message = nativeError instanceof Error ? nativeError.message : String(nativeError)
	const active = manager.lease?.active ? manager.lease : undefined
	if (active?.coordination.isCancelled?.(child)) return { state: "cancelled" }
	// Decide unowned failures only against a live binding. During a reload gap the
	// previous owner's state is unknown, so recovery reads the child's session instead.
	if (active && active === origin && !active.coordination.ownsFallback(child)) {
		return isNativeCancellation(nativeError) ? { state: "cancelled" } : { state: "error", message }
	}
	return recoverChild(manager, child, signal, message)
}

/**
 * Wait for an owned fallback result, rebinding across plugin reloads. A child
 * that the current generation does not own is read from its session until it is
 * terminal; an interrupted outcome is not a failure while a continuation may follow.
 */
async function recoverChild(
	manager: BackgroundManager,
	child: string,
	signal: AbortSignal,
	message: string,
): Promise<Finished> {
	let lease = await currentLease(manager)
	let observed: string | undefined
	let observedAt = 0
	for (;;) {
		if (signal.aborted) return { state: "cancelled" }
		if (lease.coordination.ownsFallback(child)) {
			let output: string | undefined
			try {
				output = await Promise.race([
					lease.coordination.waitForFallback(child, signal),
					lease.ended.then(() => undefined),
				])
			} catch (error) {
				// A wait rejected by a released owner is not a child failure.
				if (!lease.active) {
					lease = await currentLease(manager)
					continue
				}
				return lease.coordination.isCancelled?.(child) ? { state: "cancelled" } : { state: "error", message }
			}
			if (signal.aborted) return { state: "cancelled" }
			// The binding ended (reload) before the owner answered: wait for the next one.
			if (!lease.active) {
				lease = await currentLease(manager)
				continue
			}
			if (!output?.trim()) return lease.coordination.isCancelled?.(child) ? { state: "cancelled" } : { state: "error", message }
			return { state: "completed", output }
		}

		try {
			const info = await lease.ctx.session.get({ sessionID: child })
			if (info.time.idle === undefined) {
				observed = undefined
			} else if (info.outcome === "succeeded") {
				const output = await readV2ForegroundSubagentOutput(lease.ctx, child)
				return output?.trim() ? { state: "completed", output } : { state: "error", message: "Subagent completed without output." }
			} else if (info.outcome === "failed" || info.outcome === "interrupted") {
				// A continuation that was admitted changes the timestamps, so an
				// unchanged stop past the grace window is the terminal state.
				const mark = `${info.outcome}:${info.time.updated}:${info.time.idle}`
				const now = Date.now()
				if (mark !== observed) {
					observed = mark
					observedAt = now
				} else if (now - observedAt >= RECOVERY_TIMING.graceMs) {
					return info.outcome === "failed" ? { state: "error", message } : { state: "cancelled" }
				}
			}
		} catch (error) {
			// A read failure on a released lease rebinds; on a live lease it is retried.
			if (!lease.active) {
				lease = await currentLease(manager)
				observed = undefined
				continue
			}
			logError("V2 background recovery poll failed", { sessionID: child, error: String(error) })
		}
		await new Promise((resolve) => setTimeout(resolve, RECOVERY_TIMING.pollMs))
		if (!lease.active) {
			lease = await currentLease(manager)
			observed = undefined
		}
	}
}
