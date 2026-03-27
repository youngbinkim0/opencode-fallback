# opencode-fallback

## What This Is

An OpenCode plugin that provides automatic model fallback when API errors occur. When a model fails (rate limits, quota exhausted, 5xx errors), the plugin intercepts the error, aborts the failed request, and re-sends the last user message with the next model in a configurable fallback chain. It's the only implementation addressing the model-level failover gap described in [anomalyco/opencode#7602](https://github.com/anomalyco/opencode/issues/7602).

## Core Value

Uninterrupted AI coding sessions — when one model fails, work continues automatically on another without manual intervention.

## Requirements

### Validated

- ✓ Error-triggered fallback between different models (primary → fallback chain) — existing
- ✓ Rate limit detection (429, "rate limit", "too many requests") — existing
- ✓ 5xx/provider unavailability detection (500, 502, 503, 504) — existing
- ✓ Quota/credit exhaustion detection ("quota exceeded", "insufficient credits") — existing
- ✓ Smart error classification — retryable vs non-retryable errors — existing
- ✓ Per-agent fallback model configuration via `fallback_models` — existing
- ✓ Cooldown period for failed models before retrying them — existing
- ✓ Max fallback attempts per session to prevent infinite loops — existing
- ✓ Toast notifications on model switch (configurable) — existing
- ✓ Timeout-triggered fallback when model is unresponsive — existing
- ✓ Outgoing message model override via `chat.message` hook — existing
- ✓ Plugin config via JSON/JSONC files (project-level and global) — existing
- ✓ In-memory session state with TTL cleanup — existing

### Active

- [ ] Proactive logic audit — scrutinize every fallback path for correctness bugs, race conditions, edge cases
- [ ] Dead code removal — eliminate unreachable code paths and simplify overly complex implementations (without over-simplifying logic that serves a purpose)
- [ ] Test hardening — fill coverage gaps, add adversarial edge cases (malformed input, weird timing, race conditions), regression tests for any bugs found

### Out of Scope

- Virtual models / strategy profiles (round-robin, weighted, etc.) — significant complexity; revisit if community demands it after core gaps are closed
- Multi-account credential rotation — different concern, requires auth-layer changes in OpenCode core
- Vercel AI Gateway provider routing (`order`/`only` filters) — provider-level routing, not model-level fallback; complementary but separate
- Agent markdown frontmatter support — depends on OpenCode core config changes
- Exponential backoff — cooldown already prevents hammering; backoff adds complexity without clear benefit for the fallback use case
- Config validation at load time (Gap D) — low priority, deferred

## Context

**Origin:** GitHub issue [anomalyco/opencode#7602](https://github.com/anomalyco/opencode/issues/7602) — 20+ linked issues, strong community demand. No native OpenCode support exists. The issue is labeled "discussion" and assigned to `thdxr`. Multiple duplicate feature requests have been filed and closed referencing this issue.

**Community signals from the thread:**
- @imqqmi: wants cooldown-based recovery to primary + array syntax for models
- @stickerdaniel: wants model array syntax + cross-provider same-model fallback
- @nwpr: proposes "virtual models" abstraction with selection strategies
- @xitex: proposes strategy profiles with exponential backoff, agent markdown support
- @kostrse: wants `model` field to accept string or array (simplest API)
- @AlexMKX: $200 Claude + ChatGPT corporate plan, still hitting limits
- Multiple users: "needed!", "hoping for this soon", "needed more than ever"

**Existing codebase:** ~15 TypeScript files, Bun runtime, event-driven plugin architecture. Core fallback flow works. Four gaps identified through codebase analysis and community request mapping.

**Key technical context:**
- `message.updated` events already flow through the plugin — TTFT detection signal is available
- `auto-retry.ts` line 142-148 filters to text-only parts — non-text parts silently dropped
- `fallback-state.ts` has no recovery path — `currentModel` stays on last fallback until session ends
- `config-reader.ts` only reads per-agent config — no global fallback chain resolution

## Constraints

- **Plugin API surface**: Limited to hooks provided by `@opencode-ai/plugin` — `event`, `chat.message`, `config`. Cannot add new hooks.
- **No persistent storage**: Plugin runs in-process, state is in-memory Maps/Sets. Cannot persist across OpenCode restarts.
- **Undocumented SDK**: Event property shapes are undocumented; all extraction uses `as Record<string, unknown>` casts. Changes in `@opencode-ai/plugin` can break silently.
- **Backward compatibility**: Existing `fallback_models` config and plugin config files must continue working unchanged.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TTFT-based timeout over fixed timeout | Fixed timeout aborts models mid-stream; TTFT only aborts if no tokens arrive | — Pending |
| Global fallback in plugin config, not opencode.json | Plugin can't modify opencode.json schema; own config file is under plugin control | — Pending |
| Auto-recovery via cooldown timer on primary model | Simplest path; check if primary's cooldown expired before each new prompt | — Pending |
| Full part replay including non-text | Users send images/files; dropping them silently on retry degrades the prompt | — Pending |

## Current Milestone: v1.1 Logic Review

**Goal:** Proactive audit of the entire fallback plugin — find bugs, prune dead code, harden tests until every logic path is scrutinized and covered.

**Target features:**
- Bug hunting: fresh-eyes audit of every logic path for correctness issues, race conditions, edge cases
- Code pruning: remove dead code paths and simplify where safe, preserve logic that has a reason to exist
- Test hardening: fill coverage gaps, add adversarial edge cases (malformed input, weird timing, race conditions), regression tests for anything found

---
*Last updated: 2026-03-26 after milestone v1.1 start*
