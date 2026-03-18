# Architecture

**Analysis Date:** 2026-03-18

## Pattern Overview

**Overall:** OpenCode Plugin — Dependency-Injected Event-Driven Handler Pattern

**Key Characteristics:**
- Single exported async factory function (`OpenCodeFallbackPlugin`) is the plugin entry point
- All stateful logic lives in a shared `HookDeps` bag passed by reference to handler factories
- Handlers are created via factory functions (`createXxxHandler`) that close over `deps` — no classes
- Side effects (abort, prompt, toast) are all performed through `deps.ctx.client.*` — the plugin never touches external APIs directly
- Per-session fallback state is tracked in in-memory `Map`/`Set` collections keyed by `sessionID`

## Layers

**Plugin Entry / Wiring Layer:**
- Purpose: Instantiate dependencies, load config, assemble handler factories, return the plugin hook object
- Location: `index.ts`
- Contains: `OpenCodeFallbackPlugin` factory, config loading (`loadPluginConfig`), `HookDeps` construction, cleanup interval setup
- Depends on: All handler factories, `constants.ts`, `logger.ts`, `types.ts`
- Used by: OpenCode runtime (via `@opencode-ai/plugin` contract)

**Event Handling Layer:**
- Purpose: Receive lifecycle events from OpenCode and decide whether/when to trigger a fallback
- Location: `event-handler.ts` (session events), `message-update-handler.ts` (message.updated events)
- Contains: `createEventHandler`, `createMessageUpdateHandler`
- Depends on: `fallback-state.ts`, `error-classifier.ts`, `config-reader.ts`, `auto-retry.ts`, `logger.ts`
- Used by: `index.ts` (`plugin.event` hook)

**Chat Message Intercept Layer:**
- Purpose: Intercept outgoing chat messages and rewrite the model field when a fallback is active
- Location: `chat-message-handler.ts`
- Contains: `createChatMessageHandler`
- Depends on: `fallback-state.ts`, `logger.ts`, `types.ts`
- Used by: `index.ts` (`plugin["chat.message"]` hook)

**Fallback Execution Layer:**
- Purpose: Orchestrate abort → fetch messages → re-prompt with fallback model; manage timeouts
- Location: `auto-retry.ts`
- Contains: `createAutoRetryHelpers` (returns `AutoRetryHelpers`)
- Depends on: `fallback-state.ts`, `config-reader.ts`, `logger.ts`
- Used by: `event-handler.ts`, `message-update-handler.ts`

**State Management Layer:**
- Purpose: Pure functions that create and mutate per-session `FallbackState` (no side effects)
- Location: `fallback-state.ts`
- Contains: `createFallbackState`, `prepareFallback`, `findNextAvailableFallback`, `isModelInCooldown`
- Depends on: `types.ts`, `logger.ts`
- Used by: `event-handler.ts`, `message-update-handler.ts`, `auto-retry.ts`, `chat-message-handler.ts`

**Error Classification Layer:**
- Purpose: Extract and classify error signals from arbitrary error objects and message parts
- Location: `error-classifier.ts`
- Contains: `isRetryableError`, `classifyErrorType`, `extractStatusCode`, `extractErrorName`, `extractAutoRetrySignal`, `containsErrorContent`, `detectErrorInTextParts`
- Depends on: `constants.ts`
- Used by: `event-handler.ts`, `message-update-handler.ts`

**Config Resolution Layer:**
- Purpose: Read `fallback_models` from agent configs; resolve the active agent for a session
- Location: `config-reader.ts`
- Contains: `getFallbackModelsForSession`, `readFallbackModels`, `resolveAgentForSession`
- Depends on: nothing (pure functions)
- Used by: `event-handler.ts`, `message-update-handler.ts`, `auto-retry.ts`

**Infrastructure:**
- `constants.ts` — `PLUGIN_NAME`, `DEFAULT_CONFIG`, `RETRYABLE_ERROR_PATTERNS`
- `logger.ts` — `logInfo`/`logError` (file-based logger to `~/.config/opencode/opencode-fallback.log`)
- `types.ts` — All shared TypeScript interfaces (`FallbackState`, `HookDeps`, `PluginContext`, etc.)

## Data Flow

**Error-triggered fallback (session.error or message.updated with error):**

1. OpenCode calls `plugin.event({ event: { type: "session.error" | "message.updated", properties } })`
2. `index.ts` routes to `baseEventHandler` or `messageUpdateHandler`
3. Handler checks `config.enabled`; extracts `sessionID`, `error`, `agent` from `properties`
4. `error-classifier.ts` determines if error is retryable (`isRetryableError`)
5. `config-reader.ts` resolves the active agent name → looks up `fallback_models` list
6. `fallback-state.ts` `prepareFallback()` picks next available model (respecting cooldown), mutates `FallbackState`
7. `auto-retry.ts` `autoRetryWithFallback()`: aborts current session → fetches last user message → calls `ctx.client.session.promptAsync` with fallback model
8. A `setTimeout` fallback-timeout is armed; cleared when `message.updated` with visible response arrives

**Timeout-triggered fallback:**

1. `scheduleSessionFallbackTimeout` arms a timer (default 30 s) after each fallback prompt dispatch
2. On expiry: abort → `prepareFallback` → `autoRetryWithFallback` with next model
3. Timer is cleared on `session.idle`, `session.stop`, or successful assistant response

**Outgoing message model override (chat.message hook):**

1. OpenCode calls `plugin["chat.message"](input, output)` before sending
2. `createChatMessageHandler` checks if `state.currentModel !== state.originalModel`
3. If fallback is active, rewrites `output.message.model` to the fallback model's `providerID`/`modelID`

**Config loading:**

1. `loadPluginConfig` searches four file paths in order (project `.opencode/`, global `~/.config/opencode/`)
2. First match wins; JSONC comments are stripped before parsing
3. Merged with `configOverrides` (highest priority) and `DEFAULT_CONFIG` (lowest priority) lazily on first access

**State Management:**
- All session state stored in `Map`/`Set` fields on `HookDeps`:
  - `sessionStates: Map<sessionID, FallbackState>` — fallback chain progress per session
  - `sessionLastAccess: Map<sessionID, number>` — timestamps for TTL cleanup
  - `sessionRetryInFlight: Set<sessionID>` — guards against duplicate retry dispatches
  - `sessionAwaitingFallbackResult: Set<sessionID>` — tracks sessions waiting for fallback response
  - `sessionFallbackTimeouts: Map<sessionID, Timer>` — per-session fallback timeout handles
- Stale sessions cleaned up every 5 minutes (TTL: 30 minutes)

## Key Abstractions

**`FallbackState`:**
- Purpose: Tracks one session's fallback progression (original model, current model, attempt count, cooldown map)
- Examples: `types.ts` (interface), `fallback-state.ts` (factory + mutation logic)
- Pattern: Plain object mutated in place by `prepareFallback()`

**`HookDeps`:**
- Purpose: Dependency bag passed by reference to all handler factories — serves as shared mutable context
- Examples: `types.ts` (interface), `index.ts` (construction)
- Pattern: Constructed once in `index.ts`; handlers receive it at factory-creation time via closure

**`AutoRetryHelpers`:**
- Purpose: Encapsulates all async side-effect operations (abort, prompt, timeout scheduling)
- Examples: `auto-retry.ts`
- Pattern: Factory function returns typed object; consumed by event handlers

**`PluginContext` (`ctx`):**
- Purpose: OpenCode-provided client for interacting with sessions and TUI
- Examples: `types.ts`
- Pattern: Injected by OpenCode runtime; all external I/O goes through `ctx.client`

## Entry Points

**Plugin Factory:**
- Location: `index.ts` — default export `OpenCodeFallbackPlugin(ctx, configOverrides?)`
- Triggers: OpenCode runtime loads and invokes this on plugin startup
- Responsibilities: Load file config, build `HookDeps`, wire handlers, return plugin hook object `{ name, config, event, "chat.message" }`

**`plugin.config` hook:**
- Location: `index.ts` lines 118–132
- Triggers: OpenCode calls this after loading its own config, passing the full opencode config object
- Responsibilities: Extract `agents`/`agent` config into `agentConfigs` for use by config-reader

**`plugin.event` hook:**
- Location: `index.ts` lines 134–148
- Triggers: OpenCode emits any lifecycle event
- Responsibilities: Route `message.updated` to `messageUpdateHandler`; all others to `baseEventHandler`

**`plugin["chat.message"]` hook:**
- Location: `index.ts` lines 150–155
- Triggers: OpenCode intercepts outgoing chat message before API call
- Responsibilities: Rewrite model field if fallback is active

## Error Handling

**Strategy:** Defensive — all async operations are wrapped in try/catch; errors are logged but never re-thrown (plugin failures must not crash the host)

**Patterns:**
- `ctx.client.tui.showToast(...)` calls always end with `.catch(() => {})` — TUI failures silently discarded
- `autoRetryWithFallback` catches retry errors, cleans up in-flight state in `finally`
- `resolveAgentForSessionFromContext` catches API failures and returns `undefined` gracefully
- Logger `writeToFile` silently fails if file write fails

## Cross-Cutting Concerns

**Logging:** File-based via `logger.ts`; writes to `~/.config/opencode/opencode-fallback.log` with ISO timestamp, level, and structured JSON context. Console logging gated behind `DEBUG_MODE = false`.

**Validation:** Input validated by type-narrowing and optional chaining; no schema library. Unknown event types are silently ignored.

**Authentication:** Not applicable — auth is handled by the OpenCode runtime. The plugin only uses the injected `ctx.client`.

---

*Architecture analysis: 2026-03-18*
