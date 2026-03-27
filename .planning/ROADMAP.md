# Roadmap: opencode-fallback

## Overview

**Milestone v1.1: Logic Review** — Proactive audit of the entire fallback plugin. Each phase audits a related group of modules, fixes bugs found, removes dead code, simplifies where safe, and adds comprehensive tests. Ordered by dependency: foundational modules first (error classification, state, config), then the logic that depends on them (retry, replay, timeout/events, chat handler, subagent sync), then plugin integration, and finally a consolidation pass for cross-cutting concerns.

## v1.0 History (Complete)

- [x] Phase 1: Full Message Replay (completed 2026-03-19)
- [x] Phase 2: Global Fallback Config (completed 2026-03-19)
- [x] Phase 3: Auto-Recovery (completed 2026-03-19)
- [x] Phase 4: TTFT-Based Timeout (completed 2026-03-19)
- [x] Phase 4.1: Subagent Fallback Fix (completed 2026-03-23)

## v1.1 Phases

- [x] **Phase 5: Error Classification & State Audit** — Audit error-classifier.ts and fallback-state.ts for correctness bugs, dead code, and test gaps (completed 2026-03-27)
- [x] **Phase 6: Config & Retry Logic Audit** — Audit config-reader.ts and auto-retry.ts for precedence bugs, missed retry conditions, dead code (completed 2026-03-27)
- [x] **Phase 7: Replay & Timeout/Event Audit** — Audit message-replay.ts, event-handler.ts, message-update-handler.ts for timer leaks, race conditions, dropped parts (completed 2026-03-27)
- [x] **Phase 8: Chat Handler & Subagent Sync Audit** — Audit chat-message-handler.ts and subagent-result-sync.ts for recovery races, polling bugs, boundary conditions (completed 2026-03-27)
- [x] **Phase 9: Plugin Init & Consolidation** — Audit index.ts hook registration, add logger.ts tests, cross-module regression tests, final coverage sweep (completed 2026-03-27)

## Phase Details

### Phase 5: Error Classification & State Audit
**Goal**: Every error classification path and every state transition is verified correct — no misclassified errors, no inconsistent states, no dead code
**Depends on**: Nothing (foundational modules, no dependencies)
**Requirements**: AUDT-01, AUDT-02, QUAL-01, QUAL-02, TEST-01, TEST-02, TEST-04
**Success Criteria** (what must be TRUE):
  1. Every error string/status code path in error-classifier.ts maps to the correct classification — verified by tests with real-world error messages from each provider
  2. Every state transition in fallback-state.ts is exercised by tests — including edge cases (stale cooldowns, concurrent session access, orphaned entries after TTL expiry)
  3. Dead code in both modules identified and removed (or documented why it must stay)
  4. Adversarial inputs tested: undefined error objects, empty strings, non-standard status codes, null properties
  5. Boundary conditions tested: cooldown at exact expiry time, max attempts at boundary, empty/single-model fallback chains
**Plans:** 2/2 plans complete

Plans:
- [x] 05-01-PLAN.md — Audit error-classifier.ts: logic review, dead code removal, comprehensive test coverage
- [x] 05-02-PLAN.md — Audit fallback-state.ts: state transition review, dead code removal, adversarial/boundary tests

### Phase 6: Config & Retry Logic Audit
**Goal**: Config resolution has no precedence bugs and retry logic fires correctly in every condition — no silent config misreads, no missed retries, no false retries
**Depends on**: Phase 5 (state module may be simplified)
**Requirements**: AUDT-03, AUDT-04, QUAL-01, QUAL-02, TEST-01, TEST-02
**Success Criteria** (what must be TRUE):
  1. Every config resolution path (global-only, per-agent-only, both, neither, malformed) produces correct results — verified by tests
  2. Every retry decision condition in auto-retry.ts is exercised — including edge cases where retry should NOT fire
  3. Dead code in both modules identified and removed
  4. Adversarial inputs tested: malformed config files, missing fields, wrong types, empty arrays
**Plans:** 2/2 plans complete

Plans:
- [x] 06-01-PLAN.md — Audit config-reader.ts: precedence logic, edge cases, dead code, comprehensive tests
- [x] 06-02-PLAN.md — Audit auto-retry.ts: retry decision paths, false positive/negative conditions, dead code, tests

### Phase 7: Replay & Timeout/Event Audit
**Goal**: Message replay preserves all part types and TTFT timeout logic has no timer leaks or race conditions — no silently dropped content, no mid-stream aborts
**Depends on**: Phase 6 (retry module may be simplified)
**Requirements**: AUDT-05, AUDT-06, QUAL-01, QUAL-02, QUAL-03, TEST-01, TEST-03
**Success Criteria** (what must be TRUE):
  1. Every message part type survives replay — verified by tests with all known part types including edge cases (empty parts, huge parts, mixed arrays)
  2. TTFT timeout timer is correctly armed, cleared on first token, and never fires mid-stream — verified by timing-sensitive tests
  3. message-update-handler.ts has a dedicated test file with full coverage
  4. No timer leaks: every armed timer is cleared in all exit paths (success, error, fallback)
  5. Race conditions tested: token arrival simultaneous with timeout, multiple rapid message updates
**Plans:** 2/2 plans complete

Plans:
- [x] 07-01-PLAN.md — Audit message-replay.ts: part type handling, degradation logic, dead code, edge case tests
- [x] 07-02-PLAN.md — Audit event-handler.ts + message-update-handler.ts: timer lifecycle, race conditions, create test file for message-update-handler

### Phase 8: Chat Handler & Subagent Sync Audit
**Goal**: Recovery logic and subagent sync have no prompt-boundary races or polling bugs — recovery fires exactly when it should, subagent wait always terminates correctly
**Depends on**: Phase 7 (timeout/event modules may be simplified)
**Requirements**: AUDT-07, AUDT-08, QUAL-01, QUAL-02, TEST-01, TEST-03, TEST-04
**Success Criteria** (what must be TRUE):
  1. Recovery fires exactly at prompt boundary and never during an active fallback chain — verified by concurrent scenario tests
  2. Model override logic in chat-message-handler.ts produces correct model for every state combination
  3. Subagent polling always terminates within bounded time — including when fallback itself fails
  4. Empty result detection catches all variants (whitespace, malformed XML, partial tags)
  5. Race conditions tested: recovery trigger during active retry, concurrent subagent completions, overlapping tool.execute.after calls
**Plans:** 2/2 plans complete

Plans:
- [x] 08-01-PLAN.md — Audit chat-message-handler.ts: recovery logic, model override, prompt-boundary races, tests
- [x] 08-02-PLAN.md — Audit subagent-result-sync.ts: polling logic, empty detection variants, bounded wait, race tests

### Phase 9: Plugin Init & Consolidation
**Goal**: Plugin initialization is correct, logger is tested, and cross-module integration has regression coverage for every bug found in phases 5-8
**Depends on**: Phase 8 (all module audits complete)
**Requirements**: AUDT-09, QUAL-01, QUAL-02, QUAL-03, TEST-01, TEST-05
**Success Criteria** (what must be TRUE):
  1. Hook registration order in index.ts is verified — no ordering dependencies that could cause missed events
  2. logger.ts has a dedicated test file with coverage of all log paths
  3. Regression tests exist for every bug fixed in phases 5-8
  4. Final coverage sweep: every branch in every source module has at least one test
  5. All tests pass (existing 178+ new tests)
**Plans:** 2/2 plans complete

Plans:
- [x] 09-01-PLAN.md — Audit index.ts: hook registration, initialization order, logger.ts tests
- [x] 09-02-PLAN.md — Consolidation: regression tests for all bugs found, final coverage sweep, test run

## Progress

**Execution Order:**
Phases 5 → 6 → 7 → 8 → 9 (dependency chain: foundational → dependent → integration)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 5. Error Classification & State | 2/2 | Complete | 2026-03-27 |
| 6. Config & Retry Logic | 2/2 | Complete | 2026-03-27 |
| 7. Replay & Timeout/Event | 2/2 | Complete | 2026-03-27 |
| 8. Chat Handler & Subagent Sync | 2/2 | Complete | 2026-03-27 |
| 9. Plugin Init & Consolidation | 2/2 | Complete | 2026-03-27 |
| 10. TTFT & Race Fix | 1/1 | Complete | 2026-03-27 |
| 11. Compaction-Specific Fallback | 1/2 | In Progress|  |

**Totals:**
- Phases: 7
- Plans: 11
- Requirements: 17 mapped + 2 production bugs fixed

### Phase 10: Fix TTFT timeout false-abort and dual-handler race condition

**Goal:** Fix two production bugs found during log audit: (1) TTFT timeout aborts actively streaming primary models because firstTokenReceived is never set; (2) session.idle silent-failure and TTFT timeout both independently plan fallback for the same condition
**Depends on:** Phase 9 (bugs discovered during log review after audit)
**Success Criteria** (what must be TRUE):
  1. Any non-error message.updated for an existing session marks firstTokenReceived=true and reschedules the TTFT timeout
  2. session.idle silent-failure handler acquires retryInFlight lock BEFORE clearing the fallback timeout
  3. Regression tests verify both fixes with exact sequences observed in production logs
  4. All tests pass (358+)
**Plans:** 1/1 plans complete

Plans:
- [x] 10-01 — Fix P0 TTFT false-abort + P1 dual-handler race + regression tests (completed 2026-03-27)

### Phase 11: Compaction-Specific Fallback

**Goal:** Investigate how OpenCode's `/compact` command works internally, identify why `type: "compaction"` parts cannot be replayed through `promptAsync`, and implement a compaction-aware fallback path that correctly handles compaction failures without silent 30s timeouts
**Requirements**: COMP-01, COMP-02, TEST-06
**Depends on:** Phase 10
**Plans:** 1/2 plans executed

Plans:
- [ ] 11-01-PLAN.md — Add compaction-safe fallback dispatch using `session.command` instead of replaying `compaction` parts through `promptAsync`
- [ ] 11-02-PLAN.md — Wire compaction lifecycle hooks/events so successful compaction fallback clears timeout/awaiting state without silent stalls
