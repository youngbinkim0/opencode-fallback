# opencode-runtime-fallback

Automatic model fallback plugin for [OpenCode](https://github.com/sst/opencode). When a model API call fails, the plugin transparently switches to the next model in a configured fallback chain and replays the request — no manual intervention required.

## Features

- **Automatic fallback** — detects rate limits, quota errors, model-not-found, and other retryable failures and switches models immediately
- **Per-agent chains** — each agent can have its own ordered list of fallback models
- **Global fallback chain** — a single shared chain for agents that don't define their own
- **TTFT timeout** — aborts models that produce no tokens within a configurable window; models that are actively streaming are never interrupted
- **Cooldown & auto-recovery** — failed models enter cooldown and the plugin automatically switches back to the primary once it recovers
- **Custom retryable patterns** — extend the built-in error matching with your own regex patterns
- **Toast notifications** — optional UI feedback when models are switched, with a v2 CLI companion
- **Compaction fallback** — retries summary generation on backup models without duplicating the original task

---

## Installation

```bash
npm install opencode-runtime-fallback
```

Then add the plugin to your `opencode.json`:

```json
{
  "plugins": ["opencode-runtime-fallback"]
}
```

Version 0.3 supports **OpenCode v2** and **OpenCode v1.18.29+** through
the same package. On v1, use `"plugin"` instead of `"plugins"`.
For older v1 hosts, stay on plugin version 0.2.6 or load the legacy
`dist/v1.js` entry directly. Quit and restart OpenCode after updating.

## OpenCode v2 configuration

V2 uses a domain-based plugin API and a new session/event protocol. The plugin
uses v2 request hooks, interrupts, model selection, and prompt admission to
continue the existing conversation on a backup model. Completed tool results
remain in history; the original task is not sent again.

Configure a global chain and per-agent overrides in **plugin options**:

```json
{
  "plugins": [
    {
      "package": "opencode-runtime-fallback",
      "options": {
        "fallback_models": ["openai/gpt-5.4"],
        "timeout_seconds": 30,
        "agents": {
          "build": {
            "fallback_models": ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4#high"]
          }
        }
      }
    }
  ]
}
```

The same options, including `agents`, can go in `opencode-fallback.jsonc` at
the paths below. Inline plugin options override file settings. Non-empty
per-agent chains take precedence over the global chain. V2 model references
support `provider/model#variant`.

Existing v1 `agent.<name>.fallback_models` settings in `opencode.json` or
`opencode.jsonc` also work on v2, as does `fallback_models` in Markdown agent
frontmatter. OpenCode resolves global/project/environment configuration and
the plugin reads the resolved agent's request body before each model request.
There is no need to move your chains into a separate file. Explicit plugin
agent options (including standalone plugin-file settings) override legacy
agent settings; an empty per-agent chain uses the global chain. Non-empty per-agent chains take
precedence over the global chain. As on v1, an opted-in agent's configured
primary model is included as a recovery candidate after a manual model switch.

For a local checkout on v2, configure the package directory, not a built file:

```jsonc
"plugins": ["/absolute/path/to/opencode-fallback"]
```

V2 supports `opencode reload` and watches local plugin directories. Check the
`V2 fallback plugin initialized` log after a change: `runtime` and
`backgroundRuntime` record the imported implementation revisions and module IDs,
`runtime.buildID` identifies a compiled build (or `source`), and `generationID`
identifies each setup. A new setup alone does not prove dependencies were
re-imported. Cold restart (`opencode service restart`) clears module caches but
also loses this plugin's in-memory background delivery jobs; restart when idle.

### V2 behavior

- Retryable provider failures select the next available model after the failed
  execution settles. Before recovery takes ownership, an unavailable fallback
  preserves the host's retry policy. Once an owned chain or attempt budget is
  exhausted, retryable errors end with a final failure instead of another native
  retry loop on the last model.
- TTFT starts before model dispatch, including streams that never produce their
  first frame. Text, reasoning, or tool activity cancels the timer. Each later
  model request gets a fresh window.
- Cooldowns and maximum fallback attempts apply; later user turns can recover
  to the original model. Manual model selections are respected.
- Subagent sessions use the same session-level fallback machinery. With
  `foreground_task_fallback` enabled (the default), the native foreground
  `subagent` call stays pending through an owned fallback and returns the
  recovered child's answer to its parent. Child creation, agent selection and
  permissions remain owned by OpenCode; background outcome delivery uses the
  adapter described below.
- Background subagents (`background: true`) return OpenCode's native running
  result immediately, so the parent turn finishes and accepts new prompts while
  the child is pending. An owned fallback runs in the background child; the
  outcome is delivered once, as a native-shaped `<subagent>` notification with a
  per-call `msg_` id, after the child settles. Limitations: native explicit
  promotion and blocking job promotion remain native-owned, and the plugin cannot
  suppress native failure state. When the chain is exhausted, the child delivers
  one error outcome (`--background-exhausted`). A user interruption of the child
  delivers one cancelled outcome (`--native-cancel`). Pending delivery can rebind
  across an in-process reload; it waits for an active plugin binding and has no
  durable ledger across cold restarts. When a reloaded generation does not own
  the child, an unchanged idle failure/interruption is observed for 30 seconds
  before being reported, to allow an admitted continuation to start.
- Compaction uses a dedicated summary hook. Attempts run in temporary native
  child sessions with the saved structured history, system instructions, and
  request options for the original model; fallback models use their native
  compaction-agent options and output limits. Tools are disabled. Hung attempts are interrupted before
  advancing the chain, and children are removed afterwards. The parent model
  and agent stay selected, and no continuation prompt is appended for compaction.
  `compaction`-specific chains take precedence over the parent agent's chain.
- Without an available compaction fallback, native retries and slow streaming
  requests are preserved. Title and transient generation retain native retries.
- `notify_on_fallback` publishes typed server events to the automatically loaded
  `./tui` companion, which displays CLI toasts. Notifications are never added to
  the model conversation. Desktop notifications and sounds are opt-in below.
- Unloading cancels event subscriptions and timers and disposes registrations.
  Stream loss or unload abandons plugin-owned compaction attempts and leaves
  native summary generation available; a user interrupt cancels the compaction.

Validated against **OpenCode v2.0.27 and v2.0.28** using local mock providers for a 429
after a completed tool call, primary and backup streams with no first token,
legacy `opencode.jsonc` and Markdown agent chains, parent-visible foreground subagent
results, compaction timeout cascades and cancellation, cross-protocol compaction
fallback with model-specific output limits, compaction-specific legacy
chains, RPC delivery, and toast rendering in the real CLI. The following legacy
agent examples work on both hosts.

The remaining v2 accounting limitation is compaction cost attribution: its
summary-result API accepts token usage but cannot report a different model or
cost. Successful-attempt tokens are returned, and metadata records the actual
model. Removed temporary children do not retain attempt costs in session usage;
returned tokens may be priced against the original compaction model by the host.
Provider-specific
state is retained only when the original model produced the summary.

### V2 notification options

The CLI companion defaults to toasts. These options belong in the plugin's
inline `options` (standalone server config files do not configure CLI options):

```json
{
  "plugins": [{
    "package": "opencode-runtime-fallback",
    "options": {
      "notify_on_fallback": true,
      "notify_toast": true,
      "notify_desktop": false,
      "notify_sound": false
    }
  }]
}
```

Desktop and sound alerts are requested while the terminal is blurred and respect
OpenCode's attention settings. Terminals must report focus changes. Setting
`notify_on_fallback: false` on the server suppresses all fallback events.

---

## Setting Up Fallback Models

Add `fallback_models` to any agent in `opencode.json`:

```json
{
  "agent": {
    "coder": {
      "model": "anthropic/claude-opus-4-6",
      "fallback_models": [
        "openai/gpt-5.4",
        "kimi-for-coding/k2p5"
      ]
    }
  }
}
```

When `anthropic/claude-opus-4-6` hits a rate limit or quota error, the plugin automatically retries with `openai/gpt-5.4`, then `kimi-for-coding/k2p5` if that also fails.

A single string is accepted too:

```json
"fallback_models": "openai/gpt-4o"
```

---

## Plugin Config File

Create a config file to control plugin behaviour. The plugin looks for config in these locations in order — first match wins:

| Path | Scope |
|------|-------|
| `.opencode/opencode-fallback.jsonc` | Current project |
| `.opencode/opencode-fallback.json` | Current project |
| `~/.config/opencode/opencode-fallback.jsonc` | All projects (global) |
| `~/.config/opencode/opencode-fallback.json` | All projects (global) |

`.jsonc` files support `//` line comments.

### Full Config Reference

All fields are optional — omit any you want to keep at the default.

```jsonc
{
  // Master switch — set to false to disable the plugin entirely.
  // Default: true
  "enabled": true,

  // HTTP status codes that trigger a fallback to the next model.
  // Default: [429, 500, 502, 503, 504]
  "retry_on_errors": [429, 500, 502, 503, 504],

  // Extra regex patterns matched case-insensitively against error messages.
  // These add to the built-in patterns (rate limit, quota exceeded, etc.).
  // Each string is compiled as a regex. Invalid patterns are silently skipped.
  // Default: []
  // Example: ["billing\\s+suspended", "entity was not found"]
  "retryable_error_patterns": [],

  // Maximum number of fallback models to try before giving up.
  // Default: 10
  "max_fallback_attempts": 10,

  // How long (seconds) a failed model stays in cooldown before it can be
  // used again. During cooldown the model is skipped in the chain.
  // Default: 60
  "cooldown_seconds": 60,

  // Time-to-first-token timeout in seconds. If the model produces no output
  // within this window it is aborted and the next fallback is tried.
  // Once the model starts streaming the timeout is cancelled — streaming
  // models are never interrupted.
  // Set to 0 to disable timeouts entirely.
  // Default: 30
  "timeout_seconds": 30,

  // Show a toast notification in the UI when the plugin switches models
  // or exhausts the fallback chain.
  // Default: true
  "notify_on_fallback": true,

  // Global fallback chain. Used by agents that don't define their own
  // fallback_models in opencode.json.
  // Accepts a string (single model) or an array of strings.
  // Default: []
  "fallback_models": [],

  // Replacement for foreground task calls. Keeps the parent's task
  // promise pending across child retries. Background jobs are unsupported.
  // Default: true. Set false to use OpenCode's native task tool instead.
  "foreground_task_fallback": true
}
```

### Per-Agent vs Global Chain

`fallback_models` can be defined in two places:

1. **Per-agent** — inside the agent block in `opencode.json` (highest priority)
2. **Global** — in the plugin config file above (used as fallback when no per-agent list is set)

A non-empty per-agent list always wins. If an agent defines its own non-empty list, the global list is ignored entirely for that agent. An empty list falls back to the global chain.

```
opencode.json agent.fallback_models   ← takes priority
opencode-fallback.jsonc fallback_models  ← used if no per-agent list
(nothing)                                ← error passes through to user
```

### Agents defined in Markdown

Markdown-defined agents use the same fallback mechanism as JSON-defined
agents. No linking step is needed: OpenCode loads the agent, and the plugin
resolves its fallback chain by agent name.

For example, define `.opencode/agents/custom-review.md`:

```markdown
---
description: Review code changes
mode: subagent
model: anthropic/claude-sonnet-4-6
---
Review the changes and report actionable findings.
```

Then add a per-agent chain under that same name in `opencode.json`:

```json
{
  "agent": {
    "custom-review": {
      "fallback_models": ["openai/gpt-5.4"]
    }
  }
}
```

The Markdown prompt remains the agent's instructions; it does not override
fallback selection. A non-empty per-agent JSON chain takes precedence over
the plugin's global chain. Without one, the global chain applies. Put
`fallback_models` in JSON as shown: Markdown frontmatter handling varies
between OpenCode versions. This configuration is verified with local mock
providers on OpenCode 1.18.35.

---

## How It Works

### Foreground subagents that enter provider retry

OpenCode's native task tool can throw `Task cancelled` when its child is
aborted. On the normal tool path, `tool.execute.after` is only called after a
successful return, so it cannot reliably replace that cancellation with a
fallback result. The plugin therefore uses its own foreground task loop by
default (verified against OpenCode 1.18.35's tool registry/lifecycle).

No extra flag is required. Configure your fallback chain as usual, for example
in `opencode-fallback.jsonc`:

```jsonc
{
  "fallback_models": ["openai/gpt-5.4"]
}
```

The plugin registers a replacement `task` tool. The parent awaits a single
promise throughout the handoff: a retry signal selects a fallback, the loop
aborts and awaits its own child prompt, then synchronously prompts the same
child on the fallback with a short continuation. The original task is sent
once; retries retain the session history and completed tool results instead
of appending another copy of the task. Only the final answer is returned to
the parent. If a transport failure happened before OpenCode saved the task,
the retry sends the original instructions until their presence in history is
confirmed.
Workspace-wide rate-limit errors skip other models on the blocked provider.
If no suitable fallback exists, provider retries continue on the original
request. Real user cancellation still stops the task.

The replacement supports foreground tasks and `task_id` continuation, inherits
parent session restrictions, and uses the selected agent's permissions.
It does not support native background jobs or promotion. Prompts are sent as
text; the native task tool's `@file` expansion is not replicated. Slash-command
subtasks that invoke OpenCode's built-in task directly are not replaced.
Set `"foreground_task_fallback": false` to use OpenCode's native task tool;
native foreground child retries then remain attached to the provider.
Quit and restart OpenCode after changing the option or updating the plugin;
already-running native tasks cannot be transferred into this loop.

The regression harness runs against the installed OpenCode binary with local
mock providers: `bun run test:integration`.
It verifies that a rate-limited child switches providers, the task remains
`completed`, and the parent receives the backup answer without `Task cancelled`.

```
Primary model fails (rate limit, quota, model not found, …)
  └─▶ Abort the in-flight request
  └─▶ Continue the existing session with fallback_models[0]
        └─▶ If that also fails → fallback_models[1] → …
              └─▶ All fallbacks exhausted → surface error to user
```

**TTFT timeout** — each assistant request gets a fresh first-token window, including later turns, requests after tool calls, and auto-compaction that starts mid-turn. Repeated updates for the same message do not reset that window. If no token arrives by the deadline the model is considered hung and the next fallback is tried. Actively streaming models are never interrupted.

**Cooldown & auto-recovery** — failed models enter cooldown. On the next prompt the plugin checks whether the primary model's cooldown has expired and, if so, automatically switches back.

**Retry continuation** — automatic retries add a short continuation message
to the same session. The fallback model receives the original instructions,
conversation history, and completed tool results without another copy of the
full task prompt. Existing history still contributes to the model's input
context; this avoids prompt duplication rather than removing that history.

**Compaction-aware fallback on v1** — when `/compact` fails, the plugin detects
`agent: "compaction"` and retries via `session.summarize`, since compaction
messages cannot be replayed with `promptAsync`. Fallback models are resolved
per-agent or from the global chain. Successful `session.compacted` events
clear fallback tracking state.

Configure a compaction-specific chain on either host. On v1, leave
`agent.compaction.model` unset for model switching:

```json
{
  "agent": {
    "compaction": {
      "fallback_models": ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]
    }
  }
}
```

OpenCode v1 prefers a pinned `agent.compaction.model` over the model sent to
`session.summarize`. When that pin prevents the requested fallback, the
plugin logs an actionable error, shows a toast if notifications are enabled,
and skips re-dispatch rather than repeatedly running the failed model.
It does not change your agent's pinned model. Remove the pin and restart
OpenCode v1 to enable compaction model switching. V2 uses summary injection
and supports a pinned initial compaction model without changing the pin.

---

## Built-in Error Patterns

These errors trigger fallback automatically without any configuration:

| Error type | Trigger |
|------------|---------|
| Rate limit | HTTP 429, "rate limit", "too many requests" |
| Quota | "quota exceeded", "quota protection", "usage limit reached", "credit balance too low" |
| Service unavailable | HTTP 503/529, "service unavailable", "overloaded", "temporarily unavailable" |
| Server error | HTTP 500, 502, 504 |
| Model not found | "model not found", "model not supported", "model is not available" |
| Missing API key | API key not configured for the provider |

Add your own via `retryable_error_patterns` in the config file.

---

## Development

```bash
bun install        # install deps
bun test           # run tests
bun run build      # compile to dist/
bun run typecheck  # type check without emitting
bun run test:integration # local mock providers against installed OpenCode
bun run test:integration:v2 # requires a v2 binary; includes compaction, notifications, and real CLI checks
```

If your default binary is v1, set `OPENCODE_V2_BIN` to a v2 binary path for
`test:integration:v2`. Each host harness uses an isolated temporary configuration
and local providers. Unit tests exercise both implementations.

Additional host regressions: `bun run foreground-task.integration.ts --model-scoped`,
`--markdown-global`, `--markdown-json`, and `--main-session`. These cases
verify continuation without duplicating the original task and preservation
of completed tool results.

## License

MIT
