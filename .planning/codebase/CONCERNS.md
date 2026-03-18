# Codebase Concerns

**Analysis Date:** 2026-03-18

## Tech Debt

**Pervasive unsafe type casting on event properties:**
- Issue: The OpenCode plugin API delivers event properties as `unknown`, forcing wide `as Record<string, unknown>` casts throughout the codebase. Every event handler re-extracts fields by casting (`props?.sessionID as string | undefined`, etc.) with no runtime validation layer.
- Files: `event-handler.ts` (lines 24, 46, 70, 95, 160, 226–229, 325, 333, 485), `message-update-handler.ts` (lines 119–145), `auto-retry.ts` (lines 134, 222)
- Impact: A silent API shape change from the host SDK would produce undefined behavior with no TypeScript compile error; bugs surface at runtime only.
- Fix approach: Create a thin validation/parsing layer (using a schema library like Zod, or hand-rolled type guards) at event entry points in `event-handler.ts` and `message-update-handler.ts`. Validated structs should replace ad-hoc casts.

**Agent config accessed as `Record<string, unknown>` everywhere:**
- Issue: `agentConfigs` is typed as `Record<string, unknown> | undefined` in `types.ts` (line 101) and each consumer re-casts to `Record<string, unknown>` before accessing `.model` or `.fallback_models`. There is no typed agent config interface.
- Files: `event-handler.ts` (lines 158–162, 333–335, 402–405, 422–424), `message-update-handler.ts` (lines 289–296), `auto-retry.ts` (lines 68–73)
- Impact: Every agent config access is an implicit runtime duck-type check. A typo in the config key (e.g., `fallback_model` instead of `fallback_models`) silently returns undefined.
- Fix approach: Define an `AgentConfig` interface in `types.ts` and type `agentConfigs` as `Record<string, AgentConfig> | undefined`. The `config-reader.ts` `normalizeFallbackModelsField` already exists; just promote the type.

**`logError` misused for non-error informational events:**
- Issue: `logError` is called in `message-update-handler.ts` for normal operational paths such as "Derived model from agent config for message.updated" (line 298), "Clearing pending fallback due to provider auto-retry signal" (line 330), and "message.updated fallback skipped (pending fallback in progress)" (line 339–344). In `chat-message-handler.ts` line 39, "Detected manual model change, resetting fallback state" uses `logError`.
- Files: `message-update-handler.ts` (lines 298, 311, 321, 330, 339), `chat-message-handler.ts` (line 39)
- Impact: Log files are polluted with false ERROR-level entries during normal use; anyone monitoring the log for real errors gets false positives.
- Fix approach: Downgrade these calls to `logInfo`. Reserve `logError` for genuinely unexpected failures.

**JSONC comment stripping is a fragile regex:**
- Issue: `index.ts` lines 35–36 strip JSONC comments with two regex replacements (`/\/\/.*$/gm` and `/\/\*[\s\S]*?\*\//g`) before calling `JSON.parse`. This does not handle edge cases: comments inside strings (e.g., `"url": "https://example.com"`), regex literals, or deeply nested block comments.
- Files: `index.ts` (lines 35–36)
- Impact: A config file with a URL containing `//` would be silently corrupted. Parse errors are swallowed with a generic log message (line 38).
- Fix approach: Use an established JSONC parser (e.g., `jsonc-parser` or `strip-json-comments` npm package) instead of regex, or restrict the config format to plain JSON.

---

## Known Bugs

**Agent resolution falls back to first agent alphabetically when session agent unknown:**
- Symptoms: When a session ID has no embedded agent name and no event carries an agent field, `getFallbackModelsForSession` iterates `Object.keys(agentConfigs)` and returns the first agent's fallback models. Object key order is insertion order, which may not match the "primary" agent in multi-agent setups.
- Files: `config-reader.ts` (lines 73–76), `event-handler.ts` (lines 399–408 `findFirstAgentModel`)
- Trigger: Any session started without an explicit agent (e.g., default model in non-agent mode) with multiple agents configured.
- Workaround: None; the wrong fallback chain may be used silently.

**`autoRetryWithFallback` only replays text parts of the last user message:**
- Symptoms: If the last user message contains non-text parts (images, file attachments, tool-result parts), they are silently dropped on retry. The retry only re-sends `type === "text"` parts.
- Files: `auto-retry.ts` (lines 142–148)
- Trigger: Any session where the last user prompt included file content or images before hitting a rate-limit error.
- Workaround: None; the model receives a degraded prompt on retry.

**`data ?? sessionInfo` fallback in `resolveAgentForSessionFromContext` is a type confusion:**
- Symptoms: `ctx.client.session.get` is typed to return `{ data?: Record<string, unknown> }` but line 222 falls back with `(sessionInfo?.data ?? sessionInfo) as Record<string, unknown>`. If the SDK changes its return shape, the fallback could resolve agent to `undefined` silently.
- Files: `auto-retry.ts` (line 222)
- Trigger: SDK version mismatch between `@opencode-ai/plugin` peer dep and installed version.
- Workaround: None; agent resolution silently returns undefined.

---

## Security Considerations

**Log file may capture sensitive session content:**
- Risk: `logInfo`/`logError` calls include `firstPart: retryParts[0]?.text?.slice(0, 80)` (the first 80 characters of user messages) in `auto-retry.ts` line 158. Error messages and user message fragments are written to `~/.config/opencode/opencode-fallback.log` unconditionally.
- Files: `logger.ts` (lines 15–25), `auto-retry.ts` (line 158), `message-update-handler.ts` (line 162)
- Current mitigation: `DEBUG_MODE = false` suppresses console output; only file logging is active.
- Recommendations: Add a `log_level` config option so users can reduce verbosity. Avoid logging user message content fragments even at INFO level, or make it opt-in.

**Config file parsed with `process.env.HOME` fallback:**
- Risk: `index.ts` lines 26–27 use `process.env.HOME || ""`. On systems where `HOME` is unset, this silently resolves to paths starting from root (e.g., `/.config/opencode/...`), which may succeed if an adversarial file exists there.
- Files: `index.ts` (lines 26–27)
- Current mitigation: `existsSync` check prevents reading non-existent files.
- Recommendations: Use `os.homedir()` (already imported in `logger.ts`) instead of `process.env.HOME` for consistency and correctness.

---

## Performance Bottlenecks

**Multiple redundant `session.messages` API calls per error event:**
- Problem: For a single error event, up to three separate `session.messages` API calls may occur: (1) `checkLastAssistantForErrorContent` in `message-update-handler.ts` line 76, (2) `hasVisibleAssistantResponse` (line 35), and (3) `autoRetryWithFallback` to extract the last user message (auto-retry.ts line 126). Additionally, `resolveAgentForSessionFromContext` makes another `session.messages` call (auto-retry.ts line 202) if agent is not already known.
- Files: `message-update-handler.ts` (lines 35, 76, 158), `auto-retry.ts` (lines 126, 202)
- Cause: No caching of message list within a single event handling cycle; each helper independently fetches the full message list.
- Improvement path: Fetch message list once per event invocation and pass it down as a parameter. Or introduce a short-lived per-session message cache (TTL of a few seconds) keyed by sessionID.

**Synchronous file I/O on every log call:**
- Problem: `appendFileSync` is called on the hot path for every `logInfo`/`logError` invocation, which are very frequent (every `message.updated` event triggers multiple log calls).
- Files: `logger.ts` (line 21)
- Cause: Synchronous append is simpler but blocks the event loop on each call.
- Improvement path: Switch to a buffered async write queue, or use Node's `fs.appendFile` (async) with a small buffer, or batch log lines.

---

## Fragile Areas

**`event-handler.ts` — 512-line monolithic handler with deeply nested control flow:**
- Files: `event-handler.ts`
- Why fragile: Contains five distinct sub-handlers (`handleSessionCreated`, `handleSessionDeleted`, `handleSessionStop`, `handleSessionIdle`, `handleSessionStatus`, `handleSessionError`, `triggerImmediateFallback`) plus `findFirstAgentModel` all in one file. `handleSessionError` alone is ~170 lines with 4+ levels of nesting. The `findFirstAgentModel` helper is local to the module but duplicated in both `handleSessionStatus` (line 162) and `triggerImmediateFallback` (line 424).
- Safe modification: Add tests covering each sub-handler independently before making changes. Extract sub-handlers to separate files (e.g., `session-error-handler.ts`, `session-status-handler.ts`).
- Test coverage: No unit tests for individual sub-handlers; only the integration-style `index.test.ts` covers the event route.

**`message-update-handler.ts` — triple-path state initialization:**
- Files: `message-update-handler.ts` (lines 287–324)
- Why fragile: When session state doesn't exist, the handler tries three different sources to derive `initialModel` in sequence (event model field → agent config model → silent fail). Modifying this ordering or adding a fourth source is error-prone.
- Safe modification: Extract into a dedicated `resolveInitialModel(sessionID, model, resolvedAgent, agentConfigs)` function that makes the fallback chain explicit and testable.
- Test coverage: Not covered by any test; `index.test.ts` only validates that the handler runs without throwing.

**Session ID heuristic agent resolution:**
- Files: `config-reader.ts` (lines 39–57)
- Why fragile: `resolveAgentForSession` uses a heuristic: splits session IDs on `[\s_\-/]+` and returns the first alpha-only segment not in a noise-words set. This is likely to break if OpenCode changes its session ID format (e.g., adds UUID-style IDs). The noise word list (`ses`, `work`, `task`, `session`) is hardcoded and may not cover all future patterns.
- Safe modification: Don't rely on session ID parsing at all; require that callers always pass an explicit agent name and fall back to API lookup. The heuristic should only fire if both the event agent and API message lookup both return nothing.
- Test coverage: Tested in `config-reader.test.ts` but only for the current ID format convention.

---

## Scaling Limits

**In-memory session state with 30-minute TTL:**
- Current capacity: All session state (Maps and Sets in `index.ts` lines 95–99) lives in process memory. Cleanup runs every 5 minutes, evicting sessions idle for 30+ minutes.
- Limit: If a large number of concurrent sessions are active simultaneously, memory grows without bound between cleanup intervals. There is no maximum session count cap.
- Scaling path: Add a `max_tracked_sessions` config option; evict oldest sessions (LRU) when limit is hit. For multi-process or persistent usage, externalize state.

---

## Dependencies at Risk

**Tightly coupled to undocumented OpenCode plugin API event shapes:**
- Risk: `HookDeps`, `PluginContext`, and all event property extraction depend on undocumented internal shapes from `@opencode-ai/plugin`. The `types.ts` file manually replicates the SDK's interfaces (e.g., `PluginContext.client.session`). If the upstream SDK changes its API without a semver major bump, this plugin breaks silently.
- Impact: All event handlers stop working; fallback never triggers.
- Migration plan: Track the `@opencode-ai/plugin` changelog; add integration smoke tests that fail fast when the expected event shapes don't match.

**Peer dependency floor is loose (`>=1.1.0`):**
- Risk: `package.json` specifies `"@opencode-ai/plugin": ">=1.1.0"` as a peer dependency. Breaking changes in a future minor could pass peer dep resolution without flagging incompatibility.
- Files: `package.json` (line 17)
- Impact: Silent breakage if installed with an incompatible newer version.
- Migration plan: Tighten to a range like `">=1.1.0 <2.0.0"` or pin to a known-good minor.

---

## Missing Critical Features

**No recovery when all fallback models exhausted and primary recovers:**
- Problem: After all fallbacks are exhausted, `state.currentModel` remains set to the last fallback model. The state is only reset on `session.stop`, `session.idle`, or `session.deleted`. If the primary model recovers (rate limit clears), future requests in the same session continue using the last failed fallback until the user manually resets.
- Blocks: Automatic recovery to primary model after cooldown.

**No validation of `fallback_models` format at config load time:**
- Problem: `config-reader.ts` normalizes the `fallback_models` field but does not validate that each model string matches the expected `provider/model-id` format. Invalid strings (e.g., `"gemini-pro"` without a provider prefix) only fail at runtime in `autoRetryWithFallback` (auto-retry.ts line 106–114) with a logged message and silent skip.
- Blocks: Early error feedback when plugin is misconfigured.

---

## Test Coverage Gaps

**`event-handler.ts` sub-handlers not unit tested:**
- What's not tested: `handleSessionStatus` (provider retry detection and immediate fallback path), `handleSessionStop`, `handleSessionIdle`, `handleSessionError` (non-retryable-but-in-fallback-chain path), `triggerImmediateFallback`, `findFirstAgentModel`.
- Files: `event-handler.ts`
- Risk: Regressions in error classification routing or state mutation order go undetected.
- Priority: High

**`message-update-handler.ts` not unit tested:**
- What's not tested: The entire handler including double API call path, retry signal detection, stale-model filtering, pending fallback skip logic, and state initialization from three different sources.
- Files: `message-update-handler.ts`
- Risk: The most complex stateful logic in the codebase has no isolated test coverage. `index.test.ts` line 184 asserts `expect(true).toBe(true)` which provides no meaningful coverage.
- Priority: High

**`auto-retry.ts` not unit tested:**
- What's not tested: `abortSessionRequest`, `scheduleSessionFallbackTimeout`, `autoRetryWithFallback` (retry dispatch, text-only part filtering), `resolveAgentForSessionFromContext` (multi-step resolution), `cleanupStaleSessions`.
- Files: `auto-retry.ts`
- Risk: Timeout scheduling logic and the core retry dispatch path (which fires API calls) are untested.
- Priority: High

**`chat-message-handler.ts` not unit tested:**
- What's not tested: The model override injection logic and manual model change detection/reset.
- Files: `chat-message-handler.ts`
- Risk: Model override silently stops working if `output.message.model` assignment path breaks.
- Priority: Medium

---

*Concerns audit: 2026-03-18*
