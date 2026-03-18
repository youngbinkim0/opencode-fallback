# Testing Patterns

**Analysis Date:** 2026-03-18

## Test Frameworks

### Plugin Source Tests (root-level `.test.ts`)

**Runner:**
- Bun's built-in test runner (`bun test`)
- Config: none (no `vitest.config.*` or `jest.config.*`); Bun discovers `*.test.ts` automatically
- TypeScript types: `bun-types` (`devDependencies`)

**Assertion Library:**
- Bun's built-in `expect` (Jest-compatible API)

**Run Commands:**
```bash
bun test              # Run all *.test.ts tests
bun test --watch      # Watch mode (standard Bun flag)
```

### GSD Tooling Tests (`.opencode/get-shit-done/bin/`)

Two separate test frameworks in use:

**Vitest** (`.opencode/get-shit-done/bin/test/*.test.cjs`):
- Used for command unit tests (`set-profile.test.cjs`, `pivot-profile.test.cjs`, `get-profile.test.cjs`, `oc-profile-config.test.cjs`, `allow-read-config.test.cjs`)
- Imports: `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'`

**Node built-in test runner** (`.opencode/get-shit-done/bin/gsd-tools.test.cjs`):
- Used for CLI integration tests
- Imports: `const { test, describe, beforeEach, afterEach } = require('node:test')` + `require('node:assert')`

## Test File Organization

**Plugin tests — co-located at root:**
```
/
├── error-classifier.ts
├── error-classifier.test.ts      # Tests for error-classifier.ts
├── fallback-state.ts
├── fallback-state.test.ts        # Tests for fallback-state.ts
├── config-reader.ts
├── config-reader.test.ts         # Tests for config-reader.ts
├── index.ts
└── index.test.ts                 # Integration test for plugin entry point
```

**GSD tooling tests — co-located in `.opencode/get-shit-done/bin/`:**
```
.opencode/get-shit-done/bin/
├── gsd-tools.cjs
├── gsd-tools.test.cjs            # Integration tests (node:test runner)
└── test/
    ├── set-profile.test.cjs      # Unit tests (vitest)
    ├── pivot-profile.test.cjs
    ├── get-profile.test.cjs
    ├── oc-profile-config.test.cjs
    └── allow-read-config.test.cjs
```

**Naming:**
- Test files: `{module-name}.test.ts` (TypeScript) / `{module-name}.test.cjs` (CommonJS)
- Test files excluded from TypeScript compilation: `tsconfig.json` has `"exclude": ["*.test.ts"]`

## Test Structure

**Suite Organization (BDD-style, `#given / #when / #then`):**

All plugin tests use a three-level `describe` nesting convention:
```typescript
describe("module-name", () => {
  describe("#given functionName", () => {
    describe("#when <condition>", () => {
      test("#then <expected result>", () => {
        // assertion
      })
    })
  })
})
```

**Actual examples from `error-classifier.test.ts`:**
```typescript
describe("error-classifier", () => {
  describe("#given isRetryableError", () => {
    describe("#when error has retryable HTTP status codes", () => {
      test("#then returns true for 429", () => {
        const error = { statusCode: 429, message: "Too many requests" }
        expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
      })
    })
    describe("#when error is non-retryable", () => {
      test("#then returns false for 400", () => {
        const error = { statusCode: 400, message: "Bad request" }
        expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(false)
      })
    })
  })
})
```

**`index.test.ts` uses `it` instead of `test`:**
```typescript
describe("OpenCodeFallbackPlugin", () => {
  describe("#given a valid plugin context", () => {
    let ctx: PluginContext
    beforeEach(() => {
      ctx = createMockContext()
    })
    describe("#when plugin is initialized", () => {
      it("#then returns an object with name, config, event, and chat.message properties", async () => {
        const plugin = await OpenCodeFallbackPlugin(ctx)
        expect(plugin.name).toBe("opencode-fallback")
      })
    })
  })
})
```

**GSD tooling tests use flat `describe`/`it` style (no `#given/#when/#then`):**
```javascript
describe('Basic functionality', () => {
  it('setProfile updates profile when profile name provided', () => { ... })
  it('setProfile processes dry-run flag', () => { ... })
})
describe('Error handling', () => {
  it('handles missing config.json gracefully', () => { ... })
})
```

## Mocking

**Framework:** Bun's built-in `mock()` function (plugin tests)

**Pattern for mocking the plugin context (`index.test.ts`):**
```typescript
import { describe, expect, it, mock, beforeEach } from "bun:test"

function createMockContext(): PluginContext {
  return {
    directory: "/test/dir",
    client: {
      session: {
        abort: mock(() => Promise.resolve()),
        messages: mock(() => Promise.resolve({ data: [] })),
        promptAsync: mock(() => Promise.resolve()),
        get: mock(() => Promise.resolve({ data: {} })),
      },
      tui: {
        showToast: mock(() => Promise.resolve()),
      },
    },
  }
}
```

**Mock assertions:**
```typescript
expect(ctx.client.session.abort).toHaveBeenCalled()
expect(ctx.client.session.abort).not.toHaveBeenCalled()
```

**Vitest mocking (GSD tooling tests):**
- `vi` imported but console/process are monkey-patched manually rather than using `vi.spyOn`:
```javascript
console.log = (msg) => { allLogs.push(msg); capturedLog = msg }
process.exit = (code) => { exitCode = code; throw new Error(`process.exit(${code})`) }
```
- Originals saved and restored in `afterEach`

**What IS mocked:**
- All async I/O in `PluginContext` (session abort, messages fetch, promptAsync, session get, UI toast)
- `console.log/error` and `process.exit` in GSD tool tests
- File system operations in GSD tests use real temp directories (not mocked)

**What is NOT mocked:**
- Pure utility functions are tested without mocking — all inputs passed directly
- `error-classifier.ts`, `fallback-state.ts`, and `config-reader.ts` tests are purely functional — no mocking required

## Fixtures and Test Data

**Inline fixtures — no shared fixture files:**
```typescript
// Error shape fixtures inline in each test
const error = { statusCode: 429, message: "Too many requests" }
const info = { status: "Retrying in 5 seconds", message: "Too many requests - quota exceeded" }
const parts = [{ type: "error", text: "Something failed" }]
```

**State setup using factory functions:**
```typescript
const state = createFallbackState("anthropic/claude-opus-4-6")
state.fallbackIndex = -1
state.failedModels.set("google/model-a", Date.now())
```

**GSD tool test fixtures** — real files written to `fs.mkdtempSync` temp directories:
```javascript
beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-profile-test-'))
  fs.mkdirSync(planningDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(VALID_CONFIG, null, 2) + '\n', 'utf8')
})
afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})
```

**Config constants imported in tests:**
```typescript
import { DEFAULT_CONFIG } from "./constants"
// Used directly as test parameter
expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
```

## Coverage

**Requirements:** None enforced — no coverage threshold configuration detected

**View Coverage:**
```bash
bun test --coverage    # Bun built-in coverage (if available in version)
```

## Test Types

**Unit Tests (pure function coverage):**
- `error-classifier.test.ts` — 301 lines, tests all 8 exported functions with full happy path + edge cases
- `fallback-state.test.ts` — 201 lines, covers all 4 exported functions including sequential chaining
- `config-reader.test.ts` — 223 lines, covers all 3 exported functions including normalization edge cases

**Integration Tests (plugin wiring):**
- `index.test.ts` — 188 lines, tests the full plugin initialization and event dispatch wiring using mocked `PluginContext`

**CLI Integration Tests:**
- `.opencode/get-shit-done/bin/gsd-tools.test.cjs` — runs `gsd-tools.cjs` as a subprocess via `execSync`, parses JSON output

## Common Patterns

**Async Testing:**
```typescript
// Plugin initialization is async, tested with async/await
it("#then returns an object...", async () => {
  const plugin = await OpenCodeFallbackPlugin(ctx)
  expect(plugin.name).toBe("opencode-fallback")
})

// Event dispatch also async
await plugin.event({ event: { type: "session.error", properties: { ... } } })
expect(ctx.client.session.abort).toHaveBeenCalled()
```

**Error/Failure Testing:**
```typescript
// Testing failure return values (not thrown errors)
test("#then returns failure with maxAttemptsReached", () => {
  const state = createFallbackState("anthropic/claude-opus-4-6")
  state.attemptCount = DEFAULT_CONFIG.max_fallback_attempts
  const result = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
  expect(result.success).toBe(false)
  expect(result.maxAttemptsReached).toBe(true)
  expect(result.error).toContain("Max fallback attempts")
})
```

**Timestamp-based testing:**
```typescript
// Verify timestamp freshness within tolerance
const timestamp = state.failedModels.get("anthropic/claude-opus-4-6")!
expect(Date.now() - timestamp).toBeLessThan(1000)

// Simulate cooldown expiry with offset timestamps
state.failedModels.set("google/gemini-pro", Date.now() - 120_000)
expect(isModelInCooldown("google/gemini-pro", state, 60)).toBe(false)
```

**Sequential state mutation testing:**
```typescript
// Test chaining multiple operations on shared state
const result1 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
expect(result1.newModel).toBe("google/model-a")

const result2 = prepareFallback("session-1", state, fallbackModels, DEFAULT_CONFIG)
expect(result2.newModel).toBe("openai/model-b")
```

**Smoke tests for complex flows:**
```typescript
// When full verification isn't practical, smoke test with expect(true).toBe(true)
it("#then cleanup is performed without errors", async () => {
  await plugin.event({ event: { type: "session.deleted", ... } })
  expect(true).toBe(true)  // No assertion - just verifies no exception thrown
})
```

---

*Testing analysis: 2026-03-18*
