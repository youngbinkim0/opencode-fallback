# Roadmap: opencode-fallback

## Overview

Four targeted enhancements to an existing, working OpenCode fallback plugin. Each phase delivers one complete feature with its tests, ordered by ascending complexity: fix the data-loss bug (full replay), add config infrastructure (global fallback), add the most-requested community feature (auto-recovery), then tackle the most complex change (TTFT timeout). Each feature is independently valuable and the codebase is stable between phases.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3, 4): Planned milestone work
- Decimal phases (e.g., 2.1): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Full Message Replay** - Replay all user message parts on fallback retry, not just text (completed 2026-03-19)
- [x] **Phase 2: Global Fallback Config** - Default fallback chain for agents without per-agent config (completed 2026-03-19)
- [x] **Phase 3: Auto-Recovery** - Automatic switch back to primary model when cooldown expires (completed 2026-03-19)
- [x] **Phase 4: TTFT-Based Timeout** - Time-to-first-token timeout replaces fixed timer for smarter fallback (completed 2026-03-19)
- [~] **Phase 4.1: Subagent Fallback Fix** - INSERTED — Fix empty task results when child session fallback triggers (parent receives actual fallback response)

## Phase Details

### Phase 1: Full Message Replay
**Goal**: Users' multi-modal messages (images, files, tool results) survive fallback retries intact instead of being silently reduced to text-only
**Depends on**: Nothing (first phase)
**Requirements**: RTRY-01, RTRY-02, TEST-04
**Success Criteria** (what must be TRUE):
  1. When a fallback retry fires, all parts of the user's last message (text, images, files, tool results) are sent to the fallback model
  2. If the fallback model rejects non-text parts, the plugin falls back to text-only replay and logs a warning — the retry does not fail entirely
  3. Unit tests verify full replay with mixed part types and graceful degradation to text-only
**Plans:** 0/2 plans complete

Plans:
- [ ] 01-01-PLAN.md — TDD: Message replay module with tiered degradation (types + pure functions + unit tests)
- [ ] 01-02-PLAN.md — Integrate tiered replay into auto-retry.ts + integration tests

### Phase 2: Global Fallback Config
**Goal**: Users configure one default fallback chain instead of duplicating it across every agent
**Depends on**: Phase 1
**Requirements**: CONF-01, CONF-02, TEST-03
**Success Criteria** (what must be TRUE):
  1. A `global_fallback_models` array in the plugin config file provides a default fallback chain for any agent without its own `fallback_models`
  2. An agent's per-agent `fallback_models` completely overrides the global chain when both exist — no merging, no confusion
  3. Unit tests verify config resolution with global-only, per-agent-only, both present, and neither present scenarios
**Plans:** 0/2 plans complete

Plans:
- [ ] 02-01-PLAN.md — TDD: Config resolution with global fallback (types + pure functions + unit tests)
- [ ] 02-02-PLAN.md — Wire global config through plugin lifecycle + README docs

### Phase 3: Auto-Recovery
**Goal**: Sessions automatically return to the primary model once it recovers, ending the permanent-degradation problem
**Depends on**: Phase 2
**Requirements**: RCVR-01, RCVR-02, RCVR-03, TEST-02
**Success Criteria** (what must be TRUE):
  1. Before each new user prompt, the plugin checks if the primary model's cooldown has expired and switches back to it if available
  2. On recovery, fallback state resets cleanly (fallbackIndex and attemptCount reset) but the cooldown map of previously-failed models is preserved
  3. A toast notification appears when recovering to primary (when `notify_on_fallback` is enabled)
  4. Recovery does not trigger during an active fallback chain (guarded by retry-in-flight flags)
  5. Unit tests cover recovery at prompt boundary, state reset with cooldown preservation, and the active-chain guard
**Plans:** 0/2 plans complete

Plans:
- [ ] 03-01-PLAN.md — TDD: recoverToOriginal() pure function with unit tests
- [ ] 03-02-PLAN.md — Wire recovery into chat-message-handler + integration tests

### Phase 4: TTFT-Based Timeout
**Goal**: Timeout only fires when a model produces no tokens at all — streaming models are never aborted mid-response
**Depends on**: Phase 3
**Requirements**: RTRY-03, RTRY-04, RTRY-05, CONF-03, CONF-04, TEST-01
**Success Criteria** (what must be TRUE):
  1. When `ttft_timeout_seconds` is configured, the timeout fires only if no first assistant token arrives within the period — a model that starts streaming is never aborted by this timer
  2. The TTFT timeout timer is cleared when the first assistant token is detected via `message.updated`
  3. The existing `timeout_seconds` config continues to work unchanged for backward compatibility
  4. A model actively streaming tokens (mid-stream) is never aborted by the fallback timeout
  5. Unit tests cover TTFT timer arming, cancellation on first token, backward-compatible fixed timeout, and mid-stream protection
**Plans:** 2 plans

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD
- [ ] 04-03: TBD

### Phase 4.1: Subagent Fallback Fix
**Goal**: When a child (subagent/Task) session's model fails and the fallback plugin triggers, the parent agent receives the actual fallback model's response instead of an empty `<task_result>`
**Depends on**: Phase 4
**Requirements**: None (inserted phase — bug fix)
**Success Criteria** (what must be TRUE):
  1. When a child session's model fails and fallback triggers, the `tool.execute.after` hook intercepts the empty `<task_result>` and blocks until the fallback completes
  2. The parent agent receives the actual fallback response content instead of an empty result
  3. Polling/waiting has a configurable maximum wait time with graceful degradation if all fallbacks fail
  4. All existing fallback triggers (error, timeout, status) are covered
  5. Unit tests verify: empty result detection, session ID extraction, polling/waiting, response replacement, and timeout/graceful degradation
**Plans**: 2 plans

Plans:
- [x] 04.1-01-PLAN.md — TDD: subagent empty task-result synchronization helpers (detection, session ID extraction, bounded polling)
- [x] 04.1-02-PLAN.md — Wire tool.execute.after replacement flow + remove deferred proactive redirection + regression coverage

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Full Message Replay | 2/2 | Complete    | 2026-03-19 |
| 2. Global Fallback Config | 2/2 | Complete    | 2026-03-19 |
| 3. Auto-Recovery | 2/2 | Complete | 2026-03-19 |
| 4. TTFT-Based Timeout | 2/2 | Complete | 2026-03-19 |
| 4.1. Subagent Fallback Fix | 2/2 | Complete | 2026-03-23 |
