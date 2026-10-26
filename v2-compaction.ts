import type { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { OpenCodeEvent } from "@opencode/client"
import type { FallbackPlan, FallbackPluginConfig, FallbackState } from "./types"
import { PLUGIN_NAME } from "./constants"
import { createFallbackState, planFallback, commitFallback } from "./fallback-state"
import { isRetryableError, isProviderWideRateLimitError, getErrorMessage } from "./error-classifier"
import { logError, logInfo } from "./logger"
import type { FallbackNotifyInput } from "./v2-notifications"

/** Inert: the child's context hook replaces the request with the saved history plus SUMMARY_INSTRUCTION. */
const CHILD_PROMPT = "Produce the compaction summary."
/**
 * Self-contained equivalent of the host's native compaction prompt, including its checkpoint-merge branch.
 * The host appends its own instruction after the saved history, but the child's context hook replaces the
 * request, so the child must send this instruction itself on every request. Wording and template headings
 * are copied from the installed host's compaction prompt, so the summary matches its expected format.
 * The host accepts a summary only if it contains one of these "##" template headings.
 */
const SUMMARY_TEMPLATE = [
	"You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.",
	"<template>",
	"## Objective",
	"- [one or two brief sentences describing what the user is trying to accomplish]",
	"## Requirements",
	'- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]',
	"## Decisions",
	'- [decisions already made and why, or "(none)"]',
	"## Work State",
	"Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.",
	"### Completed",
	'- [goals that have been completed; otherwise "(none)"]',
	"### Active",
	'- [goals currently being worked on; otherwise "(none)"]',
	"### Blocked",
	'- [anything blocking progress, and why; otherwise "(none)"]',
	"## Next Move",
	'1. [ordered list of next actions, or "(none)"]',
	"## Relevant Files",
	"List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write \"(none)\".",
	"- `[file or directory path]`: [brief reason it matters]",
	"## Important Context",
	'- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]',
	"</template>",
].join("\n")
export const SUMMARY_INSTRUCTION = [
	"You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
	"If the conversation above contains an existing <conversation-checkpoint>, update that checkpoint into one consolidated summary instead of treating it as ordinary history. Newer history always takes precedence over the existing checkpoint. Preserve its information unless newer history clearly contradicts, supersedes, resolves, or makes it stale, and keep its requirements, decisions, and open questions. Incorporate newer requirements, decisions, progress, and context, and reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work. Do not reproduce the <conversation-checkpoint>, <summary>, or <recent-context> wrapper tags.",
	"Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
	SUMMARY_TEMPLATE,
	"Rules:",
	"- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.",
	"- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.",
	"- Preserve concrete facts, goals, constraints, completed progress, pending work, critical context, file paths, and next steps.",
	"- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.",
	"- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.",
	"- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.",
	"- Do not mention the summary process or that context was compacted.",
	"Do not continue the task or call tools.",
	"Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
].join("\n")
/** Children stay internal this long after removal so late events cannot trigger parent recovery. */
const REMOVED_CHILD_TTL_MS = 30_000
/** Children get no tools and no permissions, so they stay inert even if the context hook fails. */
const DENY_ALL = [{ action: "*", resource: "*", effect: "deny" as const }]

type ModelRef = SessionHooks["compaction"]["model"]
type CompactionEvent = SessionHooks["compaction"]
type ContextEvent = SessionHooks["context"]
type HttpRequestEvent = SessionHooks["http.request"]
type RetryEvent = SessionHooks["retry"]
type CompactionResult = NonNullable<CompactionEvent["result"]>

export interface V2CompactionFallbackOptions {
	config: Required<FallbackPluginConfig>
	/** Resolved fallback chain for the parent compaction's agent. */
	chain: (agent: string) => Promise<string[]> | string[]
	notify?: (input: FallbackNotifyInput) => Promise<void> | void
	/** Agent used by temporary children. Defaults to the parent compaction's agent. */
	childAgent?: (parentAgent: string) => string
	/** Called when a compaction starts so the caller can clear its main first-token timer. */
	clearMainTimer?: (sessionID: string) => void
	/** While this returns false, compactions are left to the host (no interception). */
	streamHealthy?: () => boolean
}

export interface V2CompactionFallback {
	/** Soft-cancels runs, awaits their native cleanup, and unregisters hooks. */
	dispose(): Promise<void>
	/** True for a live temporary child, or one removed within the TTL. Callers must skip it. */
	isInternal(sessionID: string): boolean
	/** Feed host events. Only parent cancellation and child progress/failure matter here. */
	handleEvent(event: OpenCodeEvent): void
	/** Hard-cancel the in-flight compaction run for a parent session. The run rejects. */
	cancel(sessionID: string): void
	/** Soft-cancel all in-flight runs. They resolve without a result so native compaction continues. */
	cancelAll(): void
}

/** A single temporary child execution for one model in the compaction chain. */
interface Attempt {
	model: string
	child?: string
	cancelled: boolean
	error?: unknown
	timedOut: boolean
	firstToken: boolean
	timer?: ReturnType<typeof setTimeout>
	stopped: Promise<never>
	stop: (error: unknown) => void
}

interface ChildRecord {
	attempt: Attempt
	snapshot: { system: unknown; messages: unknown; options: unknown }
	state: FallbackState
	chain: string[]
	/** Only the original model's child gets the saved options. Fallbacks keep host-computed options. */
	original: boolean
	/** Set once the context hook has replaced this child's request. Output is rejected otherwise. */
	contextApplied: boolean
}

/**
 * soft: the run is abandoned and resolves without a result, so the host's native
 * compaction pipeline runs. hard: the run rejects. A hard cancel always wins.
 */
type CancelMode = "soft" | "hard"

interface Run {
	sessionID: string
	startedAt: number
	cancel?: CancelMode
	attempt?: Attempt
}

type AttemptOutcome =
	| { ok: true; result: CompactionResult }
	| { ok: false; error: unknown; forceFallback: boolean }

const noop = () => {}

function modelName(model: ModelRef): string {
	return `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`
}

function parseModel(value: string): { id: string; providerID: string; variant?: string } {
	const slash = value.indexOf("/")
	if (slash < 1 || slash === value.length - 1) throw new Error(`Invalid fallback model: ${value}`)
	const [id, variant] = value.slice(slash + 1).split("#")
	if (!id) throw new Error(`Invalid fallback model: ${value}`)
	return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

function createAttempt(model: string): Attempt {
	let stop!: (error: unknown) => void
	const stopped = new Promise<never>((_, reject) => { stop = reject })
	// Stops are observed through race(); this keeps an unobserved stop from becoming unhandled.
	stopped.catch(noop)
	return { model, cancelled: false, timedOut: false, firstToken: false, stopped, stop: (error) => stop(error) }
}

/** Thrown only for this module's own cancellations. The compaction wrapper resolves soft ones. */
class CompactionCancelled extends Error {
	constructor() {
		super("Compaction fallback cancelled")
	}
}

function cancellation(): Error {
	return new CompactionCancelled()
}

/** Wraps the last failure so callers see an Error whose message and cause both survive. */
function exhausted(cause: unknown): Error {
	return new Error(`Compaction fallback failed: ${getErrorMessage(cause)}`, { cause })
}

/**
 * Compaction-time fallback. Each attempt runs the saved history (system, messages,
 * options) plus SUMMARY_INSTRUCTION in a host-native temporary child session, so the
 * parent's model, agent, attempt options, and request are never modified. The result is returned to the parent compaction
 * hook only when a child produces non-empty summary text.
 */
export async function installV2CompactionFallback(
	ctx: Plugin.Context,
	options: V2CompactionFallbackOptions,
): Promise<V2CompactionFallback> {
	const { config } = options
	const children = new Map<string, ChildRecord>()
	const removed = new Map<string, number>()
	/** Latest run per parent session. Superseded runs are cancelled, not overwritten. */
	const runs = new Map<string, Run>()
	/** Every run promise (settled or not) so dispose can await native cleanup. */
	const active = new Set<Promise<unknown>>()
	/** Per parent session, failed models persist across compactions for cooldown. */
	const failures = new Map<string, Map<string, number>>()
	const registrations: Registration[] = []
	let disposed = false

	const attemptFail = (attempt: Attempt, error: unknown, timedOut = false) => {
		if (attempt.error !== undefined) return
		attempt.error = error
		attempt.timedOut = timedOut
		attempt.stop(error)
	}
	const cancelAttempt = (attempt: Attempt) => {
		attempt.cancelled = true
		attemptFail(attempt, cancellation())
		if (attempt.child) {
			const child = attempt.child
			void ctx.session.interrupt({ sessionID: child, resume: false }).catch((error) => {
				if (!disposed) logError("V2 compaction child interrupt failed", { sessionID: child, error: String(error) })
			})
		}
	}
	const cancelRun = (run: Run, mode: CancelMode) => {
		if (run.cancel === "hard" || run.cancel === mode) return
		const first = run.cancel === undefined
		run.cancel = mode
		if (first && run.attempt) cancelAttempt(run.attempt)
	}
	/** Real parent cancellation: the run rejects. */
	const cancel = (sessionID: string) => {
		const run = runs.get(sessionID)
		if (run) cancelRun(run, "hard")
	}
	/** Stream loss or dispose: the run resolves without a result so native compaction continues. */
	const cancelAll = () => {
		for (const run of runs.values()) cancelRun(run, "soft")
	}
	const race = <T>(attempt: Attempt, promise: Promise<T>): Promise<T> => Promise.race([promise, attempt.stopped])
	const markFirstToken = (attempt: Attempt) => {
		attempt.firstToken = true
		clearTimeout(attempt.timer)
		attempt.timer = undefined
	}
	const isInternal = (sessionID: string) => {
		if (children.has(sessionID)) return true
		const expires = removed.get(sessionID)
		if (expires === undefined) return false
		if (expires > Date.now()) return true
		removed.delete(sessionID)
		return false
	}
	const rememberRemoved = (sessionID: string) => {
		const now = Date.now()
		for (const [id, expires] of removed) if (expires <= now) removed.delete(id)
		removed.set(sessionID, now + REMOVED_CHILD_TTL_MS)
	}

	/** Removes an ephemeral child. Interrupts first when the attempt did not complete. */
	const discard = async (child: string, interrupt: boolean) => {
		if (interrupt) {
			try {
				await ctx.session.interrupt({ sessionID: child, resume: false })
			} catch (error) {
				if (!disposed) logError("V2 compaction child interrupt failed", { sessionID: child, error: String(error) })
			}
		}
		try {
			await ctx.session.remove({ sessionID: child })
		} catch (error) {
			if (!disposed) logError("V2 compaction child removal failed", { sessionID: child, error: String(error) })
		}
	}

	const armFirstTokenTimer = (attempt: Attempt, parentID: string, state: FallbackState, chain: string[]) => {
		attempt.timer = setTimeout(() => {
			if (attempt.firstToken || attempt.cancelled || attempt.error !== undefined) return
			// Only abort when a fallback can advance; otherwise a slow healthy attempt is the best option left.
			if (!planFallback(parentID, state, chain, config).success) return
			logInfo("V2 compaction first-token window expired", { sessionID: parentID, model: attempt.model })
			attemptFail(attempt, new Error(`First token timeout after ${config.timeout_seconds}s`), true)
		}, config.timeout_seconds * 1000)
		attempt.timer.unref?.()
	}

	/** Runs one attempt. Throws only for cancellation; failures are returned as outcomes. */
	async function runAttempt(
		parentID: string,
		run: Run,
		parentAgent: string,
		model: string,
		snapshot: ChildRecord["snapshot"],
		state: FallbackState,
		chain: string[],
		from: string | undefined,
	): Promise<AttemptOutcome> {
		if (run.cancel !== undefined) throw cancellation()
		const attempt = createAttempt(model)
		run.attempt = attempt
		let child: string | undefined
		let record: ChildRecord | undefined
		let prompt: Promise<unknown> | undefined
		let succeeded = false
		try {
			const admission = ctx.session.create({
				parentID,
				title: "Compaction fallback",
				agent: options.childAgent?.(parentAgent) ?? parentAgent,
				model: parseModel(model),
				location: { directory: ctx.location.directory },
				metadata: { [PLUGIN_NAME]: true, compaction: true },
				permissions: DENY_ALL,
			})
			let created: { id: string }
			try {
				created = await race(attempt, admission)
			} catch (error) {
				// Admission can finish after cancellation. Wait for it so the
				// admitted child is interrupted and removed before the hook settles.
				if (attempt.cancelled) {
					const orphan = await admission.then((session) => session.id, () => undefined)
					if (orphan) {
						rememberRemoved(orphan)
						await discard(orphan, true)
					}
				}
				throw error
			}
			child = created.id
			record = { attempt, snapshot, state, chain, original: model === state.originalModel, contextApplied: false }
			children.set(child, record)
			if (attempt.cancelled) throw cancellation()
			if (from !== undefined) notifyFallback(parentID, from, model)
			if (config.timeout_seconds > 0) armFirstTokenTimer(attempt, parentID, state, chain)
			prompt = ctx.session.prompt({
				sessionID: child,
				text: CHILD_PROMPT,
				resume: true,
				metadata: { [PLUGIN_NAME]: true },
			})
			await race(attempt, prompt)
			if (attempt.cancelled) throw cancellation()
			await race(attempt, ctx.session.wait({ sessionID: child }).catch((error: unknown) => {
				attemptFail(attempt, error)
			}))
			if (attempt.error !== undefined) return { ok: false, error: attempt.error, forceFallback: attempt.timedOut }
			if (!record.contextApplied) {
				return { ok: false, error: new Error("Compaction child was not scoped by the context hook"), forceFallback: true }
			}
			const messages = await race(attempt, ctx.session.context({ sessionID: child }))
			const assistant = [...messages].reverse().find((message) => message.type === "assistant")
			if (!assistant) return { ok: false, error: new Error("Compaction child produced no output"), forceFallback: true }
			if (assistant.error) return { ok: false, error: assistant.error, forceFallback: false }
			const summary = assistant.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim()
			if (!summary) return { ok: false, error: new Error("Compaction child produced an empty summary"), forceFallback: true }
			// Provider state is only valid for the model that produced it. Text-part state is never promoted.
			const providerState = model === state.originalModel ? assistant.providerState : undefined
			succeeded = true
			return {
				ok: true,
				result: {
					summary,
					...(providerState ? { providerState } : {}),
					...(assistant.tokens ? { tokens: assistant.tokens } : {}),
					metadata: { [PLUGIN_NAME]: true, model, fallback: model !== state.originalModel, chain: chain.length },
				},
			}
		} catch (error) {
			if (attempt.cancelled) throw cancellation()
			if (attempt.error !== undefined) return { ok: false, error: attempt.error, forceFallback: attempt.timedOut }
			return { ok: false, error, forceFallback: false }
		} finally {
			clearTimeout(attempt.timer)
			attempt.timer = undefined
			run.attempt = undefined
			// A prompt that is still admitting must settle before the child is interrupted and removed.
			if (prompt) await prompt.then(noop, noop)
			if (child) {
				await discard(child, !succeeded)
				children.delete(child)
				rememberRemoved(child)
			}
		}
	}

	const notifyFallback = (sessionID: string, from: string, to: string) => {
		logInfo("V2 compaction fallback admitted", { sessionID, from, to })
		void Promise.resolve()
			.then(() => options.notify?.({ sessionID, from, to, kind: "compaction" }))
			.catch((error) => logError("V2 compaction notification failed", { error: String(error) }))
	}

	const execute = async (run: Run, event: CompactionEvent, snapshot: ChildRecord["snapshot"]): Promise<void> => {
		const chain = await options.chain(event.agent)
		if (run.cancel !== undefined) throw cancellation()
		if (!chain.length) return

		const state = createFallbackState(modelName(event.model))
		const stored = failures.get(event.sessionID)
		if (stored) state.failedModels = new Map(stored)
		let first: unknown
		let previous: string | undefined
		try {
			for (;;) {
				const outcome = await runAttempt(event.sessionID, run, event.agent, state.currentModel, snapshot, state, chain, previous)
				// A cancelled run never produces a result, even if its attempt had already finished.
				if (run.cancel !== undefined) throw cancellation()
				if (outcome.ok) {
					event.result = outcome.result
					return
				}
				first ??= outcome.error
				if (!outcome.forceFallback && !isRetryableError(outcome.error, config.retry_on_errors, config.retryable_error_patterns)) throw exhausted(first)
				const blocked = isProviderWideRateLimitError(outcome.error) ? state.currentModel.split("/")[0] : undefined
				const next = planFallback(event.sessionID, state, chain, config, blocked)
				if (!next.success) throw exhausted(first)
				commitFallback(state, next as FallbackPlan)
				previous = next.failedModel
				logInfo("V2 compaction fallback selected", { sessionID: event.sessionID, from: next.failedModel, to: next.newModel })
			}
		} finally {
			// Cancelled runs must not overwrite the failure memory of the run that replaced them.
			if (run.cancel === undefined) storeFailures(event.sessionID, state)
		}
	}

	/** Keeps only failures still inside cooldown; drops the parent entry when none remain. */
	const storeFailures = (sessionID: string, state: FallbackState) => {
		const now = Date.now()
		const cooldownMs = config.cooldown_seconds * 1000
		const live = new Map([...state.failedModels].filter(([, failedAt]) => now - failedAt < cooldownMs))
		if (live.size) failures.set(sessionID, live)
		else failures.delete(sessionID)
	}

	const compaction = (event: CompactionEvent): Promise<void> | void => {
		if (disposed || event.result || options.streamHealthy?.() === false) return
		options.clearMainTimer?.(event.sessionID)
		// Snapshot before any await so later host mutations cannot reach the child.
		const snapshot = structuredClone({ system: event.system, messages: event.messages, options: event.options })
		// A superseded run is a real parent cancellation for its own compaction, so it rejects.
		const previous = runs.get(event.sessionID)
		if (previous) cancelRun(previous, "hard")
		const run: Run = { sessionID: event.sessionID, startedAt: Date.now() }
		runs.set(event.sessionID, run)
		const work = execute(run, event, snapshot)
			.catch((error: unknown) => {
				// Resume native compaction only for this run's own soft cancellation. Other errors propagate.
				if (run.cancel === "soft" && error instanceof CompactionCancelled) return undefined
				throw error
			})
			.finally(() => {
				// Runs that fail before any attempt (chain lookup, empty chain) also release ownership.
				if (runs.get(event.sessionID) === run) runs.delete(event.sessionID)
			})
		const tracked = work.then(noop, noop)
		active.add(tracked)
		void tracked.then(() => { active.delete(tracked) })
		return work
	}

	const context = (event: ContextEvent) => {
		const record = children.get(event.sessionID)
		if (!record) return
		// Children get the saved history (system, messages, options) with tools removed. Clone per request.
		const copy = structuredClone(record.snapshot)
		event.system = copy.system as typeof event.system
		const messages = copy.messages as typeof event.messages
		// The snapshot is older history only. Its final message may be a real user turn, so the
		// summary instruction is always appended, whatever the last role, as the host would append it.
		messages.push({ role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }] })
		event.messages = messages
		// Omit the key rather than sending an empty map: the host must not expose any tools to the child.
		delete (event as Partial<ContextEvent>).tools
		// Fallback children keep the host-computed options, which belong to their own model.
		if (record.original) event.options = copy.options as typeof event.options
		record.contextApplied = true
	}

	const httpRequest = async (event: HttpRequestEvent) => {
		if (!children.has(event.sessionID)) return
		const request = event.request
		if (!request.headers.get("content-type")?.toLowerCase().includes("json")) return
		let body: unknown
		try {
			body = await request.clone().json()
		} catch {
			return
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) return
		const payload = body as Record<string, unknown>
		if (!Array.isArray(payload.tools) || payload.tools.length !== 0) return
		const sanitized = { ...payload }
		delete sanitized.tools
		const headers = new Headers(request.headers)
		headers.delete("content-length")
		event.request = new Request(request, { headers, body: JSON.stringify(sanitized) })
	}

	const retry = (event: RetryEvent) => {
		const record = children.get(event.sessionID)
		if (!record || !isRetryableError(event.error, config.retry_on_errors, config.retryable_error_patterns)) return
		// Native retry would repeat the same child model. Take over only when the chain can advance.
		const blocked = isProviderWideRateLimitError(event.error) ? record.state.currentModel.split("/")[0] : undefined
		if (planFallback(event.sessionID, record.state, record.chain, config, blocked).success) {
			event.decision = { retry: false }
		}
	}

	const handleEvent = (event: OpenCodeEvent) => {
		const data = event.data as { sessionID?: string; delta?: string; error?: unknown }
		const sessionID = data.sessionID
		if (!sessionID) return
		const record = children.get(sessionID)
		if (record) {
			const attempt = record.attempt
			if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
				if (data.delta?.length) markFirstToken(attempt)
			} else if (event.type === "session.execution.failed") {
				// Step failures are left to native retry; the retry hook decides whether this run takes over.
				attemptFail(attempt, data.error ?? new Error("Compaction child failed"))
			} else if (event.type === "session.execution.interrupted" || event.type === "session.deleted") {
				attemptFail(attempt, new Error(`Compaction child ${event.type}`))
			}
			return
		}
		// Late events from removed children must not be read as parent cancellation.
		if (isInternal(sessionID)) return
		if (event.type === "session.deleted") {
			failures.delete(sessionID)
			cancel(sessionID)
			return
		}
		if (event.type === "session.execution.interrupted") {
			// An interrupt recorded before this run started belongs to an earlier turn.
			const created = (event as { created?: number }).created
			const run = runs.get(sessionID)
			if (run && created !== undefined && created < run.startedAt) return
			cancel(sessionID)
		}
	}

	const registerHooks = async () => {
		// Registered before the main v2 context hook: children must be scoped before v2 tracks them.
		registrations.push(await ctx.session.hook("context", context))
		registrations.push(await ctx.session.hook("http.request", httpRequest))
		registrations.push(await ctx.session.hook("retry", retry))
		registrations.push(await ctx.session.hook("compaction", compaction))
	}

	try {
		await registerHooks()
	} catch (error) {
		await Promise.all(registrations.map((registration) => registration.dispose()))
		throw error
	}

	return {
		async dispose() {
			if (disposed) return
			disposed = true
			cancelAll()
			// Each tracked promise settles only after native cleanup, and cleanup errors are caught.
			await Promise.all([...active])
			failures.clear()
			removed.clear()
			await Promise.all(registrations.map((registration) => registration.dispose()))
		},
		isInternal,
		handleEvent,
		cancel,
		cancelAll,
	}
}
