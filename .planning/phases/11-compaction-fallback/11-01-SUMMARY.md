---
phase: 11-compaction-fallback
plan: 01
subsystem: retry
tags: [compaction, session-command, fallback, toast, tdd]

# Dependency graph
requires:
  - phase: 10-ttft-race-fix
    provides: TTFT timeout and retry lock patterns
provides:
  - Compaction-aware fallback dispatch via session.command
  - Agent-based compaction detection (agent === "compaction")
  - Toast notifications for compaction fallback trigger and exhaustion
  - Regression tests for compaction-origin fallback
affects: [event-handler, message-update-handler, auto-retry]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Agent-based dispatch routing: when agent=compaction, use session.command instead of promptAsync"
    - "Command-based retry: session.command({command:'compact', model, agent}) for compaction re-dispatch"

key-files:
  created: []
  modified:
    - types.ts
    - auto-retry.ts
    - auto-retry.test.ts

key-decisions:
  - "Compaction detection uses resolvedAgent === 'compaction' check in autoRetryWithFallback — no part-type inspection needed"
  - "Compaction branch inserted before normal replay path — early return avoids message fetch + replayWithDegradation overhead"
  - "session.command passes model as string (providerID/modelID), not {providerID, modelID} object — matches SDK command signature"
  - "Toast notification fires inside compaction branch (before command dispatch) rather than in callers — simpler, no caller changes needed"

patterns-established:
  - "Agent-based dispatch routing in autoRetryWithFallback for agent-specific retry paths"

requirements-completed: [COMP-01, TEST-06]

# Metrics
duration: 4min
completed: 2026-03-27
---

# Phase 11 Plan 01: Compaction Fallback Dispatch Summary

**Agent-based compaction detection with session.command fallback dispatch, toast notifications, and 6 regression tests**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-27T21:22:25Z
- **Completed:** 2026-03-27T21:27:19Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Compaction failures detected via `agent === "compaction"` — consistent with per-agent config resolution
- Compaction fallback uses `session.command` instead of `promptAsync` — avoids SDK limitation with `type: "compaction"` parts
- Same guards as normal path: stale-plan check, duplicate-dispatch prevention, commit-after-accept, timeout scheduling
- 6 new regression tests covering dispatch, config resolution, state management, failure cleanup, and toast notifications

## Task Commits

Each task was committed atomically:

1. **Task 1: Add failing compaction-origin dispatch tests** - `5f025d5` (test)
2. **Task 2: Implement agent-based compaction detection and command dispatch** - `e257c3a` (feat)

## Files Created/Modified
- `types.ts` - Added `session.command` to PluginContext contract matching SDK signature
- `auto-retry.ts` - Added compaction-specific dispatch branch using session.command when agent=compaction
- `auto-retry.test.ts` - Added 6 compaction tests + commandFn mock to createMockDeps

## Decisions Made
- Compaction detection uses `resolvedAgent === "compaction"` — the agent field is already extracted by message-update-handler and event-handler, no changes needed in those files
- Compaction branch inserted at the top of the try block (before message fetch) — compaction doesn't need message replay, so skipping the fetch is a clean optimization
- Toast notification fires inside the compaction dispatch path before the command call — keeps notification logic co-located with the dispatch
- `session.command` passes `model` as a plain string (`"providerID/modelID"`) — matches the SDK command signature (unlike promptAsync which takes `{providerID, modelID}`)

## Deviations from Plan

None - plan executed exactly as written.

The plan specified changes to `message-update-handler.ts` and `event-handler.ts` for extracting the `agent` field, but inspection confirmed both already extract and pass `agent` to the resolution chain. No changes were needed.

## Issues Encountered

Pre-existing test failures in `error-classifier.test.ts` (20 failures) caused by uncommitted changes in `constants.ts` that added 401 to `retry_on_errors`. These are outside the scope of this plan. All `auto-retry.test.ts` tests pass (47/47).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Compaction dispatch path complete — ready for Plan 02 (compaction lifecycle hooks/events for success detection)
- `session.command` contract in types.ts available for any future command-based dispatch needs

## Self-Check: PASSED

- All key files exist on disk ✓
- Both task commits verified in git log ✓
- 47/47 auto-retry tests pass ✓
- Typecheck passes ✓

---
*Phase: 11-compaction-fallback*
*Completed: 2026-03-27*
