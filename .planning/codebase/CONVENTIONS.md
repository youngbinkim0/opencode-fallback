# Coding Conventions

**Analysis Date:** 2026-03-18

## Naming Patterns

**Files:**
- `kebab-case` for all source files: `error-classifier.ts`, `fallback-state.ts`, `config-reader.ts`, `chat-message-handler.ts`
- Test files co-located with source, same name + `.test.ts` suffix: `error-classifier.test.ts`
- Config/constants files use single-word names: `constants.ts`, `types.ts`, `logger.ts`

**Functions:**
- `camelCase` for all functions: `getErrorMessage`, `extractStatusCode`, `isRetryableError`
- Factory functions prefixed with `create`: `createFallbackState`, `createAutoRetryHelpers`, `createEventHandler`, `createMessageUpdateHandler`, `createChatMessageHandler`
- Boolean-returning functions use predicate prefixes: `is` (`isRetryableError`, `isModelInCooldown`), `has` (`hasVisibleAssistantResponse`), `contains` (`containsErrorContent`)
- Action functions use verb prefixes: `extract`, `classify`, `detect`, `prepare`, `find`, `resolve`, `read`, `get`

**Variables:**
- `camelCase` for all variables and parameters
- `snake_case` exclusively for config keys that map to JSON/file config: `retry_on_errors`, `max_fallback_attempts`, `cooldown_seconds`, `timeout_seconds`, `notify_on_fallback`
- Constants in `SCREAMING_SNAKE_CASE`: `PLUGIN_NAME`, `DEFAULT_CONFIG`, `RETRYABLE_ERROR_PATTERNS`, `SESSION_TTL_MS`, `SESSION_ID_NOISE_WORDS`
- Session tracking Maps/Sets use `session` prefix: `sessionStates`, `sessionLastAccess`, `sessionRetryInFlight`, `sessionAwaitingFallbackResult`, `sessionFallbackTimeouts`

**Types/Interfaces:**
- `PascalCase` for all interfaces: `FallbackPluginConfig`, `FallbackState`, `FallbackResult`, `HookDeps`, `PluginContext`
- No `I` prefix on interfaces
- Type aliases in `PascalCase`: `AgentRecord`, `AutoRetryHelpers`
- Exported type for factory return value: `export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>`

## Code Style

**Formatting:**
- No `.prettierrc` or `biome.json` detected — formatting is manually consistent
- Tabs for indentation throughout all TypeScript source files
- No trailing semicolons (semicolon-free style)
- Single blank line between functions; double blank line not used
- Opening braces on same line (Allman style NOT used)

**TypeScript:**
- `strict: true` in `tsconfig.json` — strict null checks and type safety enforced
- `target: ESNext`, `module: ESNext`, `moduleResolution: bundler`
- `import type { ... }` used for type-only imports: `import type { HookDeps } from "./types"`
- Explicit return types on public/exported functions NOT consistently used (return types inferred)
- `unknown` used for external error types: `error: unknown`
- Type assertions via casting to `Record<string, unknown>` before property access

**Linting:**
- No `.eslintrc*` detected — no enforced linting configuration

## Import Organization

**Order:**
1. Type imports (`import type { ... } from "./types"`)
2. Named imports from local modules (`import { DEFAULT_CONFIG } from "./constants"`)
3. Named imports from other local modules
4. Node built-ins last (only in entry/build files): `import { readFileSync, existsSync } from "fs"`

**Path Aliases:**
- None configured — all imports use relative paths with `./` prefix
- No barrel/index re-exports observed

**Pattern:**
```typescript
import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { logInfo, logError } from "./logger"
import { extractStatusCode, classifyErrorType, isRetryableError } from "./error-classifier"
import { createFallbackState, prepareFallback } from "./fallback-state"
import { getFallbackModelsForSession } from "./config-reader"
```

## Error Handling

**Strategy:** Errors are passed as `unknown` and inspected via utility functions in `error-classifier.ts`

**Patterns:**
- Never throw from error handling paths — all errors surface via return values or logging
- `try/catch` with empty `catch {}` used to silently swallow non-critical errors (file writes, directory creation): `} catch { // Silently fail if can't write to file }`
- External API errors caught and logged, never re-thrown: `catch (error) { logError(..., { error: String(error) }) }`
- Functions return structured result objects instead of throwing: `FallbackResult { success: boolean, newModel?, error?, maxAttemptsReached? }`
- Toast notifications `.catch(() => {})` to prevent UI errors from bubbling
- Guard clauses return early on missing data: `if (!sessionID) return`

**Error Classification** (`error-classifier.ts`):
- `getErrorMessage(error: unknown): string` — extracts a normalized lowercase message
- `extractStatusCode(error: unknown): number | undefined` — handles nested error shapes
- `classifyErrorType(error: unknown): string | undefined` — returns semantic type strings: `"missing_api_key"`, `"invalid_api_key"`, `"model_not_found"`
- `isRetryableError(error: unknown, retryOnErrors: number[]): boolean` — top-level retry decision

## Logging

**Framework:** Custom file-based logger in `logger.ts`

**Functions:**
- `logInfo(message: string, context?: Record<string, unknown>): void`
- `logError(message: string, context?: Record<string, unknown>): void`
- `getLogFilePath(): string`

**Log file location:** `~/.config/opencode/opencode-fallback.log`

**Patterns:**
- Log at start of significant operations with context object
- Log model transitions with `from`/`to` fields: `logInfo("Applying fallback model override", { sessionID, from, to })`
- Console output gated by `DEBUG_MODE = false` constant — production logs to file only
- Context objects always have `sessionID` as first key when available
- Log format: `[ISO-timestamp] [LEVEL] [plugin-name] message {context-json}`

## Comments

**When to Comment:**
- Block comments on complex decision logic: `// Ignore stale errors from models we already moved past`
- Module-level JSDoc on `config-reader.ts` explaining what it reads and what it does NOT read
- `declare function` blocks used to extend global type signatures without full re-declaration
- Inline comments on non-obvious config merging precedence

**JSDoc/TSDoc:**
- Used sparingly — only on the `config-reader.ts` module header
- Not used on individual exported functions
- File-level block comment in `.opencode/get-shit-done/` test files explaining the module under test

## Function Design

**Size:** Functions are medium-large; event handler functions (`handleSessionError`) can be 100+ lines when they encode complex state machine logic

**Parameters:**
- Dependencies injected via `HookDeps` object rather than passed individually
- Factory functions (`createEventHandler(deps, helpers)`) receive all dependencies at creation time and close over them
- Pure utility functions (`isRetryableError`, `extractStatusCode`) take explicit parameters — no hidden deps

**Return Values:**
- Structured result objects for fallible operations: `{ success: boolean, newModel?: string, error?: string }`
- `undefined` returned (not `null`) for optional/missing values
- `string[]` (never `null`) returned from config readers — empty array as safe default
- Async functions return `Promise<void>` when result not needed by caller

## Module Design

**Exports:**
- One primary export per module (usually a factory or set of pure functions)
- `index.ts` has a single `export default async function OpenCodeFallbackPlugin(...)`
- Utility modules export multiple named functions: `error-classifier.ts`, `fallback-state.ts`, `config-reader.ts`

**Barrel Files:**
- Not used — each module is imported directly by path

**Factory Pattern:**
The codebase uses a consistent dependency injection factory pattern:
```typescript
// Factory takes deps object and returns handler function(s)
export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  // Close over deps
  const { config, sessionStates } = deps

  // Private helper functions
  const handleSessionError = async (props) => { ... }

  // Return the handler
  return async ({ event }) => {
    if (event.type === "session.error") {
      await handleSessionError(props)
    }
  }
}
```

**State Management:**
- Shared mutable state lives in `HookDeps` Maps/Sets, passed by reference to all handlers
- State mutations are explicit (no reactive frameworks)
- Session lifecycle tracked in five parallel collections: `sessionStates`, `sessionLastAccess`, `sessionRetryInFlight`, `sessionAwaitingFallbackResult`, `sessionFallbackTimeouts`

---

*Convention analysis: 2026-03-18*
