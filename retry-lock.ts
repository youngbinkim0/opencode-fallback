import type { HookDeps } from "./types"

/** A delayed handler may release only the retry lock it acquired. */
export function acquireRetryLock(deps: HookDeps, sessionID: string): symbol {
	const token = Symbol(sessionID)
	const owners = deps.sessionRetryLockTokens ??= new Map<string, symbol>()
	owners.set(sessionID, token)
	deps.sessionRetryInFlight.add(sessionID)
	return token
}

export function releaseRetryLock(deps: HookDeps, sessionID: string, token: symbol | undefined): void {
	if (deps.sessionRetryLockTokens?.get(sessionID) !== token) return
	deps.sessionRetryLockTokens?.delete(sessionID)
	deps.sessionRetryInFlight.delete(sessionID)
}
