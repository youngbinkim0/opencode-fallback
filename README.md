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
  "fallback_models": []
}
```

### Per-Agent vs Global Chain

`fallback_models` can be defined in two places:

1. **Per-agent** — inside the agent block in `opencode.json` (highest priority)
2. **Global** — in the plugin config file above (used as fallback when no per-agent list is set)

Per-agent always wins. If an agent defines its own list, the global list is ignored entirely for that agent.

```
opencode.json agent.fallback_models   ← takes priority
opencode-fallback.jsonc fallback_models  ← used if no per-agent list
(nothing)                                ← error passes through to user
```

---

## How It Works

```
Primary model fails (rate limit, quota, model not found, …)
  └─▶ Abort the in-flight request
  └─▶ Replay the last user message with fallback_models[0]
        └─▶ If that also fails → fallback_models[1] → …
              └─▶ All fallbacks exhausted → surface error to user
```

**TTFT timeout** — after sending to a fallback model a timer starts. If no token arrives by the deadline the model is considered hung and the next fallback is tried. Actively streaming models are never interrupted.

**Cooldown & auto-recovery** — failed models enter cooldown. On the next prompt the plugin checks whether the primary model's cooldown has expired and, if so, automatically switches back.

**Message replay** — the last user message is re-sent with a three-tier degradation strategy: (1) all parts, (2) text + images only, (3) text only — maximising compatibility across providers.

**Compaction-aware fallback** — when `/compact` fails, the plugin detects compaction by checking the `agent: "compaction"` field and retries via `session.command` instead of `promptAsync` (compaction messages contain parts that `promptAsync` cannot accept). Fallback models are resolved per-agent — configure a `"compaction"` agent in your fallback config, or fall back to the global chain. Toast notifications fire on compaction fallback trigger and when all fallback models are exhausted. The same TTFT timeout applies: compaction streaming produces `compaction_delta` events that keep the timer alive just like normal chat tokens. When compaction completes successfully, the plugin clears all fallback tracking state via the `session.compacted` event.

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
```

## License

MIT
