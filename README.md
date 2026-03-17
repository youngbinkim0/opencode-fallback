# opencode-fallback

Automatic model fallback plugin for [OpenCode](https://github.com/sst/opencode). Switches to backup models when API errors occur (rate limits, quota exceeded, service unavailable, etc.).

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-fallback"]
}
```

## Configuration

Add `fallback_models` to your agent configs in `opencode.json`:

```json
{
  "agent": {
    "opus": {
      "mode": "primary",
      "model": "anthropic/claude-opus-4-6",
      "fallback_models": [
        "google/antigravity-claude-opus-4-6-thinking",
        "github-copilot/claude-opus-4.6"
      ]
    },
    "sonnet": {
      "mode": "primary",
      "model": "anthropic/claude-sonnet-4-6",
      "fallback_models": [
        "google/antigravity-claude-sonnet-4-6-thinking",
        "github-copilot/claude-sonnet-4.6"
      ]
    },
    "gemini": {
      "mode": "primary",
      "model": "google/antigravity-gemini-3.1-pro",
      "fallback_models": [
        "github-copilot/gemini-3.1-pro-preview"
      ]
    }
  }
}
```

Each agent can have its own list of fallback models. When the primary model fails, the plugin tries each fallback in order.

A single string is also accepted and will be normalized to a one-element array:

```json
{
  "fallback_models": "google/antigravity-claude-opus-4-6-thinking"
}
```

## How It Works

1. **Error detection** -- When a model API call fails with a retryable error, the plugin intercepts it.

2. **Fallback chain** -- The plugin automatically tries the next model in the `fallback_models` list for the current agent.

3. **Auto-retry** -- The current request is aborted and the last user message is re-sent with the fallback model.

4. **Toast notifications** -- A notification appears showing which model is now being used (configurable).

5. **Cooldown** -- Failed models enter a cooldown period (default 60 seconds) before being retried again.

6. **Max attempts** -- The plugin stops trying after 3 fallback attempts per session (configurable) to avoid infinite loops.

### Fallback Flow

```
Primary model fails (e.g., 429 rate limit)
  -> Try fallback_models[0]
    -> If that fails too, try fallback_models[1]
      -> If all fallbacks exhausted, show error to user
```

## Error Types Handled

| Error Type | Description |
|------------|-------------|
| Rate limit | HTTP 429, "rate limit", "too many requests" |
| Quota exceeded | "quota exceeded", "credit balance too low", "insufficient credits" |
| Service unavailable | HTTP 503, "service unavailable", "overloaded", "temporarily unavailable" |
| Server error | HTTP 500, 502, 504 |
| Model not found | Model identifier not recognized by the provider |
| Missing API key | API key not configured for the provider |

## Retryable HTTP Status Codes

The following status codes trigger automatic fallback:

- **429** -- Too Many Requests (rate limited)
- **500** -- Internal Server Error
- **502** -- Bad Gateway
- **503** -- Service Unavailable
- **504** -- Gateway Timeout

## Plugin Configuration

Create a config file at `.opencode/opencode-fallback.json` (or `.jsonc` for comments):

```json
{
  "max_fallback_attempts": 5,
  "cooldown_seconds": 120,
  "notify_on_fallback": false
}
```

### Available Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the fallback mechanism |
| `retry_on_errors` | `[429, 500, 502, 503, 504]` | HTTP status codes that trigger fallback |
| `max_fallback_attempts` | `3` | Maximum fallback attempts per session |
| `cooldown_seconds` | `60` | Time before retrying a failed model |
| `timeout_seconds` | `30` | Timeout for fallback model retry requests |
| `notify_on_fallback` | `true` | Show toast notifications on model switch |

### Config File Locations

The plugin looks for config in these locations (first match wins):

1. `.opencode/opencode-fallback.json` (project-level)
2. `.opencode/opencode-fallback.jsonc` (project-level with comments)
3. `~/.config/opencode/opencode-fallback.json` (global)
4. `~/.config/opencode/opencode-fallback.jsonc` (global with comments)

### Config Priority

1. Programmatic overrides (when loading manually)
2. Config file (from locations above)
3. Built-in defaults

## Requirements

- [OpenCode](https://github.com/sst/opencode) with plugin support (`@opencode-ai/plugin >= 1.1.0`)
- At least one agent with `fallback_models` configured

## Using Local Version (Before Publishing)

To test the plugin locally before publishing to npm:

**Option 1: Local plugin directory**

Place the plugin files in your OpenCode plugins directory:

```bash
# Project-level
mkdir -p .opencode/plugins/opencode-fallback
cp src/standalone-plugin/*.ts .opencode/plugins/opencode-fallback/

# Or global
mkdir -p ~/.config/opencode/plugins/opencode-fallback
cp src/standalone-plugin/*.ts ~/.config/opencode/plugins/opencode-fallback/
```

**Option 2: bun link**

```bash
# In the plugin directory
cd src/standalone-plugin
bun link

# In your project directory
bun link opencode-fallback
```

Then reference it in `opencode.json`:

```json
{
  "plugin": ["opencode-fallback"]
}
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck

# Build
bun run build
```

## License

MIT
