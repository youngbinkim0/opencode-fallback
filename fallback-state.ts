import type { FallbackState, FallbackResult, FallbackPluginConfig, FallbackPlan, FallbackPlanFailure } from "./types"
import { logInfo } from "./logger"

export interface FallbackStateSnapshot {
	currentModel: string
	fallbackIndex: number
	failedModels: Map<string, number>
	attemptCount: number
	pendingFallbackModel?: string
}

export function snapshotFallbackState(state: FallbackState): FallbackStateSnapshot {
	return {
		currentModel: state.currentModel,
		fallbackIndex: state.fallbackIndex,
		failedModels: new Map(state.failedModels),
		attemptCount: state.attemptCount,
		pendingFallbackModel: state.pendingFallbackModel,
	}
}

export function restoreFallbackState(
	state: FallbackState,
	snapshot: FallbackStateSnapshot
): void {
	state.currentModel = snapshot.currentModel
	state.fallbackIndex = snapshot.fallbackIndex
	state.failedModels = new Map(snapshot.failedModels)
	state.attemptCount = snapshot.attemptCount
	state.pendingFallbackModel = snapshot.pendingFallbackModel
}

export function createFallbackState(originalModel: string): FallbackState {
	return {
		originalModel,
		currentModel: originalModel,
		fallbackIndex: -1,
		failedModels: new Map<string, number>(),
		attemptCount: 0,
		pendingFallbackModel: undefined,
	}
}

export function isModelInCooldown(
	model: string,
	state: FallbackState,
	cooldownSeconds: number
): boolean {
	const failedAt = state.failedModels.get(model)
	if (failedAt === undefined) return false
	const cooldownMs = cooldownSeconds * 1000
	return Date.now() - failedAt < cooldownMs
}

export function findNextAvailableFallback(
	state: FallbackState,
	fallbackModels: string[],
	cooldownSeconds: number
): string | undefined {
	for (let i = state.fallbackIndex + 1; i < fallbackModels.length; i++) {
		const candidate = fallbackModels[i]
		// Never select the model that is currently failing — that would
		// create an infinite retry loop.
		if (candidate === state.currentModel) {
			logInfo(`Skipping fallback model identical to current: ${candidate} (index ${i})`)
			continue
		}
		if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
			return candidate
		}
		logInfo(`Skipping fallback model in cooldown: ${candidate} (index ${i})`)
	}
	return undefined
}

function applyFallbackPlan(
	state: FallbackState,
	plan: FallbackPlan,
	pendingFallbackModel?: string
): void {
	state.fallbackIndex = plan.newFallbackIndex
	state.failedModels.set(plan.failedModel, Date.now())
	state.attemptCount++
	state.currentModel = plan.newModel
	state.pendingFallbackModel = pendingFallbackModel
}

export function prepareFallback(
	sessionID: string,
	state: FallbackState,
	fallbackModels: string[],
	config: Required<FallbackPluginConfig>,
): FallbackResult {
	const plan = planFallback(sessionID, state, fallbackModels, config)
	if (!plan.success) {
		return plan
	}

	applyFallbackPlan(state, plan, plan.newModel)
	return { success: true, newModel: plan.newModel }
}

/**
 * Phase 1: Determine the next fallback model WITHOUT mutating state.
 * Returns a plan that can be committed later via commitFallback().
 */
export function planFallback(
	sessionID: string,
	state: FallbackState,
	fallbackModels: string[],
	config: Required<FallbackPluginConfig>,
): FallbackPlan | FallbackPlanFailure {
	if (state.attemptCount >= config.max_fallback_attempts) {
		logInfo(`Max fallback attempts reached for session ${sessionID} (${state.attemptCount})`)
		return {
			success: false,
			error: "Max fallback attempts reached",
			maxAttemptsReached: true,
		}
	}

	const nextModel = findNextAvailableFallback(state, fallbackModels, config.cooldown_seconds)

	if (!nextModel) {
		logInfo(`No available fallback models for session ${sessionID}`)
		return {
			success: false,
			error: "No available fallback models (all in cooldown or exhausted)",
		}
	}

	logInfo(
		`Planned fallback for session ${sessionID}: ${state.currentModel} -> ${nextModel} (will be attempt ${state.attemptCount + 1})`
	)

	return {
		success: true,
		newModel: nextModel,
		failedModel: state.currentModel,
		newFallbackIndex: fallbackModels.indexOf(nextModel),
	}
}

/**
 * Phase 2: Commit a planned fallback to state. Call this AFTER the replay
 * dispatch to promptAsync succeeds, so state only advances when the new
 * model is actually being called.
 *
 * Idempotent: if the state already shows this plan's model (i.e. another
 * handler already committed the same plan), this is a no-op and returns false.
 */
export function commitFallback(
	state: FallbackState,
	plan: FallbackPlan,
): boolean {
	// Reject stale or already-committed plans. A plan is only valid if the state
	// still reflects the model that originally failed when the plan was created.
	if (state.currentModel !== plan.failedModel) {
		return false
	}

	applyFallbackPlan(state, plan)
	return true
}

export function recoverToOriginal(
	state: FallbackState,
	cooldownSeconds: number
): boolean {
	if (state.currentModel === state.originalModel) return false
	if (isModelInCooldown(state.originalModel, state, cooldownSeconds)) return false

	state.currentModel = state.originalModel
	state.fallbackIndex = -1
	state.attemptCount = 0
	state.pendingFallbackModel = undefined

	return true
}
