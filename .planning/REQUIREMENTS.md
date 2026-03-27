# Requirements: opencode-fallback

**Defined:** 2026-03-26
**Core Value:** Uninterrupted AI coding sessions — when one model fails, work continues automatically on another without manual intervention.

## v1.1 Requirements

Requirements for milestone v1.1 Logic Review. Each maps to roadmap phases.

### Logic Audit

- [x] **AUDT-01**: Every error classification path in `error-classifier.ts` is verified correct — no misclassified errors that would trigger wrong fallback behavior
- [x] **AUDT-02**: Every state transition in `fallback-state.ts` is verified correct — no states that can become inconsistent (stale cooldowns, incorrect fallbackIndex, orphaned entries)
- [x] **AUDT-03**: Every retry decision path in `auto-retry.ts` is verified correct — no conditions where retry fires incorrectly or fails to fire when it should
- [x] **AUDT-04**: Every config resolution path in `config-reader.ts` is verified correct — no precedence bugs between global and per-agent config
- [x] **AUDT-05**: Message replay logic in `message-replay.ts` is verified correct — no part types silently dropped or corrupted during replay
- [x] **AUDT-06**: TTFT timeout logic (across `event-handler.ts`, `message-update-handler.ts`) is verified correct — no timer leaks, no mid-stream aborts, no race between token arrival and timeout
- [x] **AUDT-07**: Chat message handler recovery and model override logic in `chat-message-handler.ts` is verified correct — no prompt-boundary race conditions
- [x] **AUDT-08**: Subagent result sync logic in `subagent-result-sync.ts` is verified correct — no polling races, no missed empty results, bounded wait always terminates
- [x] **AUDT-09**: Plugin initialization and hook registration in `index.ts` is verified correct — no hook ordering dependencies that could cause missed events

### Code Quality

- [x] **QUAL-01**: Dead code paths identified and removed — unreachable branches, unused exports, redundant checks
- [x] **QUAL-02**: Overly complex implementations simplified where safe — without removing logic that serves a defensive or edge-case purpose
- [x] **QUAL-03**: `message-update-handler.ts` and `logger.ts` have dedicated test files (currently untested modules)

### Test Hardening

- [x] **TEST-01**: Coverage gaps filled — every branch in every source module has at least one test exercising it
- [x] **TEST-02**: Adversarial edge cases added — malformed event payloads, undefined/null properties, unexpected types where `as Record<string, unknown>` casts are used
- [x] **TEST-03**: Race condition tests added — concurrent fallback triggers, overlapping timeout/retry, recovery during active fallback chain
- [x] **TEST-04**: Boundary condition tests added — empty fallback chains, single-model chains, max attempts at boundary, cooldown at exact expiry time
- [x] **TEST-05**: Regression tests added for every bug found during audit phases

## Future Requirements

Deferred to future milestone. Tracked but not in current roadmap.

## Post-v1.1 Active Requirements

Added after the v1.1 audit milestone to cover compaction-specific fallback behavior discovered in production use.

### Compaction Fallback

- [x] **COMP-01**: Compaction-origin fallback uses the OpenCode compaction command path with the fallback model — `type: "compaction"` parts are never replayed through `promptAsync`
- [x] **COMP-02**: Successful compaction fallback is recognized through compaction lifecycle signals (`experimental.session.compacting`, `session.compacted`) — the plugin does not wait for assistant text or a fixed timeout to mark success
- [x] **TEST-06**: Regression tests cover compaction-origin fallback dispatch, lifecycle cleanup, and silent-failure prevention

### Observability

- **OBSV-01**: Fallback event metrics (count, duration, which models failed/succeeded)
- **OBSV-02**: Provider metadata in responses showing actual provider used

### Advanced Routing

- **ROUT-01**: Virtual model abstraction with selection strategies (round-robin, priority, weighted)
- **ROUT-02**: Named strategy profiles for reusable retry/backoff configs
- **ROUT-03**: Agent markdown frontmatter support for fallback config

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| New fallback features | v1.1 is audit-only; new features belong in v1.2+ |
| Performance optimization | Not the goal — correctness and coverage first |
| Config validation at load time | Deferred from v1.0, still low priority |
| Multi-account credential rotation | Different concern — requires auth-layer changes in OpenCode core |
| Model array syntax in opencode.json | Requires OpenCode core schema changes |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUDT-01 | Phase 5: Error Classification & State | Complete |
| AUDT-02 | Phase 5: Error Classification & State | Complete |
| AUDT-03 | Phase 6: Config & Retry Logic | Complete |
| AUDT-04 | Phase 6: Config & Retry Logic | Complete |
| AUDT-05 | Phase 7: Replay & Timeout/Event | Complete |
| AUDT-06 | Phase 7: Replay & Timeout/Event | Complete |
| AUDT-07 | Phase 8: Chat Handler & Subagent Sync | Complete |
| AUDT-08 | Phase 8: Chat Handler & Subagent Sync | Complete |
| AUDT-09 | Phase 9: Plugin Init & Consolidation | Complete |
| QUAL-01 | Phases 5-9 (each phase prunes its modules) | Complete |
| QUAL-02 | Phases 5-9 (each phase simplifies its modules) | Complete |
| QUAL-03 | Phase 7 (message-update-handler) + Phase 9 (logger) | Complete |
| TEST-01 | Phases 5-9 (each phase fills its coverage gaps) | Complete |
| TEST-02 | Phase 5: Error Classification & State | Complete |
| TEST-03 | Phase 7 + Phase 8 (race condition tests) | Complete |
| TEST-04 | Phase 5 + Phase 8 (boundary condition tests) | Complete |
| TEST-05 | Phase 9: Plugin Init & Consolidation | Complete |
| COMP-01 | Phase 11: Compaction-Specific Fallback | Planned |
| COMP-02 | Phase 11: Compaction-Specific Fallback | Planned |
| TEST-06 | Phase 11: Compaction-Specific Fallback | Planned |

**Coverage:**
- v1.1 requirements: 17 total
- Mapped to phases: 17 ✓
- Complete: 17 ✓
- Unmapped: 0

---
*Requirements defined: 2026-03-26*
*Last updated: 2026-03-27 — all requirements complete*
