# opencode-runtime-fallback

Automatic model fallback plugin for [OpenCode](https://github.com/sst/opencode). When a model API call fails, the plugin transparently switches to the next model in a configured fallback chain and replays the request — no manual intervention required.

## Features

- **Automatic fallback** — detects rate limits, quota errors, model-not-found, and other retryable failures and switches models immediately
- **Per-agent chains** — each agent can have its own ordered list of fallback models
- **Global fallback chain** — a single shared chain for agents that don't define their own
- **TTFT timeout** — aborts models that produce no tokens within a configurable window; models that are actively streaming are never interrupted
- **Cooldown & auto-recovery** — failed models enter cooldown and the plugin automatically switches back to the primary once it recovers
- **Custom retryable patterns** — extend the built-in error matching with your own regex patterns
- **Toast notifications** — optional UI feedback when models are switched

---

## Installation

```bash
npm install opencode-runtime-fallback
```

Then add the plugin to your `opencode.json`:

```json
{
  "plugin": ["opencode-runtime-fallback"]
}
```

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

**Compaction-aware fallback** — when `/compact` fails, the plugin detects
`agent: "compaction"` and retries via `session.summarize`, since compaction
messages cannot be replayed with `promptAsync`. Fallback models are resolved
per-agent or from the global chain. Successful `session.compacted` events
clear fallback tracking state.

For compaction model switching, leave `agent.compaction.model` unset:

```json
{
  "agent": {
    "compaction": {
      "fallback_models": ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]
    }
  }
}
```

OpenCode prefers a pinned `agent.compaction.model` over the model sent to
`session.summarize`. When that pin prevents the requested fallback, the
plugin logs an actionable error, shows a toast if notifications are enabled,
and skips re-dispatch rather than repeatedly running the failed model.
It does not change your agent's pinned model. Remove the pin and restart
OpenCode to enable compaction model switching.

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
```

Additional host regressions: `bun run foreground-task.integration.ts --model-scoped`,
`--markdown-global`, `--markdown-json`, and `--main-session`. These cases
verify continuation without duplicating the original task and preservation
of completed tool results.

## License

MIT
