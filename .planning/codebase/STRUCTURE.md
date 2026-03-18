# Codebase Structure

**Analysis Date:** 2026-03-18

## Directory Layout

```
opencode-fallback/          # Root — all source files live flat at root level
├── index.ts                # Plugin entry point; factory function; wires everything
├── types.ts                # All shared TypeScript interfaces
├── constants.ts            # PLUGIN_NAME, DEFAULT_CONFIG, RETRYABLE_ERROR_PATTERNS
├── logger.ts               # File-based logger (writes to ~/.config/opencode/)
├── config-reader.ts        # Reads fallback_models from agent configs; resolves agent name
├── fallback-state.ts       # Pure functions: create/mutate FallbackState per session
├── error-classifier.ts     # Classify/extract error signals from error objects and message parts
├── auto-retry.ts           # Async side-effect helpers: abort, prompt, timeout scheduling
├── event-handler.ts        # Handles session.* lifecycle events from OpenCode
├── message-update-handler.ts  # Handles message.updated events from OpenCode
├── chat-message-handler.ts # Intercepts outgoing chat.message to rewrite model field
├── build.ts                # Bun build script (not included in tsconfig compilation)
├── package.json            # npm package metadata; peerDep on @opencode-ai/plugin >=1.1.0
├── tsconfig.json           # TypeScript config; excludes *.test.ts and build.ts
├── README.md               # Plugin documentation
├── *.test.ts               # Collocated test files (bun:test)
├── .gitignore              # Ignores dist/
├── opencode.json           # OpenCode config for the repo itself
├── .opencode/              # OpenCode workspace config (agents, commands, skills)
│   ├── agents/
│   ├── commands/gsd/
│   ├── get-shit-done/
│   ├── rules/
│   └── skills/
└── .planning/              # GSD planning output (not shipped in package)
    └── codebase/
```

## Directory Purposes

**Root (`.`):**
- Purpose: All plugin source files are flat at root — no `src/` subdirectory
- Contains: TypeScript source modules, test files, build config, package.json
- Key files: `index.ts` (entry point), `types.ts` (shared interfaces), `constants.ts`

**`dist/` (generated, not committed):**
- Purpose: Compiled output — the files actually shipped via npm
- Contains: `index.js` (ESM bundle), `index.d.ts` (type declarations per module)
- Generated: Yes (by `bun run build.ts`)
- Committed: No (in `.gitignore`)

**`.opencode/`:**
- Purpose: OpenCode workspace tooling for this repo's own development workflow (GSD commands, agent configs, skills)
- Contains: Agent definitions, slash commands, bin scripts, rules
- Key files: `.opencode/commands/gsd/` (custom OpenCode slash commands)
- Note: This is NOT part of the distributed plugin — it's the repo's development environment

**`.planning/codebase/`:**
- Purpose: GSD-generated architecture analysis documents consumed by planning/execution commands
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, STACK.md, etc.
- Committed: Intended yes (reference docs for Claude Code instances)

## Key File Locations

**Entry Points:**
- `index.ts`: Plugin factory `OpenCodeFallbackPlugin(ctx, configOverrides?)` — default export, async

**Shared Contracts:**
- `types.ts`: All interfaces — `FallbackPluginConfig`, `FallbackState`, `FallbackResult`, `HookDeps`, `PluginContext`, `ChatMessageInput`, `ChatMessageOutput`

**Configuration:**
- `constants.ts`: `DEFAULT_CONFIG` defaults, `PLUGIN_NAME`, `RETRYABLE_ERROR_PATTERNS` regex array
- `config-reader.ts`: Runtime config reading from injected `agentConfigs`; agent name resolution

**Core Logic:**
- `fallback-state.ts`: Pure state transitions — `createFallbackState`, `prepareFallback`
- `error-classifier.ts`: Error detection — `isRetryableError`, `extractAutoRetrySignal`, `classifyErrorType`
- `auto-retry.ts`: Async orchestration — `autoRetryWithFallback`, timeout management

**Event Handlers:**
- `event-handler.ts`: Routes `session.created`, `session.deleted`, `session.stop`, `session.idle`, `session.error`, `session.status`
- `message-update-handler.ts`: Routes `message.updated` (assistant errors and success detection)
- `chat-message-handler.ts`: Intercepts `chat.message` to apply model override

**Infrastructure:**
- `logger.ts`: `logInfo` / `logError` — appends to `~/.config/opencode/opencode-fallback.log`

**Build:**
- `build.ts`: Bun build script — bundles `index.ts` to `dist/`, then runs `tsc --emitDeclarationOnly`
- `tsconfig.json`: Strict TypeScript, ESNext module, outputs to `dist/`

**Testing:**
- `index.test.ts`: Integration-style plugin factory tests
- `config-reader.test.ts`: Unit tests for agent config reading and agent resolution
- `error-classifier.test.ts`: Unit tests for error detection/classification
- `fallback-state.test.ts`: Unit tests for state creation and fallback preparation

## Naming Conventions

**Files:**
- `kebab-case.ts` for all source files (e.g., `error-classifier.ts`, `fallback-state.ts`)
- `kebab-case.test.ts` for collocated test files (e.g., `error-classifier.test.ts`)
- Module name matches its primary export's conceptual domain (e.g., `fallback-state.ts` exports `FallbackState`-related functions)

**Functions:**
- `camelCase` for all functions
- Factory functions prefixed with `create` (e.g., `createEventHandler`, `createAutoRetryHelpers`, `createFallbackState`)
- Handler factories return a handler function directly (not an object with methods, except `createAutoRetryHelpers`)
- Boolean helpers use verb prefix: `isRetryableError`, `isModelInCooldown`
- Extractors prefixed with `extract`: `extractStatusCode`, `extractErrorName`, `extractAutoRetrySignal`

**Types / Interfaces:**
- `PascalCase` for all interfaces and types (e.g., `FallbackState`, `HookDeps`, `PluginContext`)
- No `I` prefix on interfaces

**Constants:**
- `SCREAMING_SNAKE_CASE` for module-level constants (e.g., `PLUGIN_NAME`, `DEFAULT_CONFIG`, `SESSION_TTL_MS`)

## Where to Add New Code

**New event type handler:**
- Add `handleSessionXxx` function inside `event-handler.ts` and wire it in the return dispatcher
- Or add a new `createXxxEventHandler.ts` if the handler is large

**New error detection pattern:**
- Add regex to `RETRYABLE_ERROR_PATTERNS` in `constants.ts`
- Or add a new `classifyErrorType` branch in `error-classifier.ts`

**New config option:**
- Add field to `FallbackPluginConfig` interface in `types.ts`
- Add default value in `DEFAULT_CONFIG` in `constants.ts`
- Merge it in `getConfig()` inside `index.ts`

**New utility/helper:**
- Pure functions with no I/O: add to the most relevant existing module or create a new `kebab-case.ts` file
- Async side-effect helpers: add to `auto-retry.ts` and expose via `AutoRetryHelpers`

**New tests:**
- Collocate test file as `module-name.test.ts` next to the module under test
- Use `bun:test` (`describe`, `it`, `mock`, `beforeEach`)

**Type definitions:**
- All shared interfaces belong in `types.ts`
- Module-local types may be defined inline in the module file

## Special Directories

**`dist/`:**
- Purpose: npm-published build output
- Generated: Yes (by `bun run build`)
- Committed: No

**`.opencode/`:**
- Purpose: Dev-environment OpenCode workspace tooling (not part of plugin)
- Generated: No
- Committed: Yes

**`.planning/`:**
- Purpose: GSD codebase analysis docs for Claude Code planning/execution
- Generated: Yes (by GSD map commands)
- Committed: Yes (reference for future Claude Code sessions)

---

*Structure analysis: 2026-03-18*
