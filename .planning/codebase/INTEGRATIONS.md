# External Integrations

**Analysis Date:** 2026-03-18

## APIs & External Services

**OpenCode Plugin API:**
- OpenCode — The host application this plugin runs inside; all external calls go through the injected `PluginContext` client
  - SDK/Client: `@opencode-ai/plugin` (peer dep), `@opencode-ai/sdk` (transitive)
  - Auth: None — the plugin context is provided by OpenCode at plugin load time; API keys for AI providers are managed by OpenCode, not by this plugin
  - Entry: `ctx` parameter injected into `OpenCodeFallbackPlugin(ctx, configOverrides?)`

**AI Model Providers (indirect):**
- The plugin does not directly call any AI provider APIs. It uses the OpenCode SDK client to re-submit prompts, and OpenCode routes those to the configured AI provider (Anthropic, Google, GitHub Copilot, etc.)
- Provider/model pairs are referenced only as strings in config (e.g., `"anthropic/claude-opus-4-6"`, `"google/antigravity-gemini-3.1-pro"`)

## Data Storage

**Databases:**
- None — no database connections

**File Storage:**
- Local filesystem only:
  - Log file: `~/.config/opencode/opencode-fallback.log` (append-only, written via `appendFileSync` in `logger.ts`)
  - Config file: `~/.config/opencode/opencode-fallback.json[c]` or `<project>/.opencode/opencode-fallback.json[c]` (read-only at plugin init in `index.ts`)

**Caching:**
- None — in-memory only (session state maps in `HookDeps`)

## Authentication & Identity

**Auth Provider:**
- None — this plugin has no authentication of its own
- All AI provider authentication is handled externally by OpenCode

## Monitoring & Observability

**Error Tracking:**
- None — no external error tracking service

**Logs:**
- File-based logging to `~/.config/opencode/opencode-fallback.log`
- Format: `[ISO-timestamp] [LEVEL] [opencode-fallback] message {context_json}`
- Functions: `logInfo()`, `logError()` in `logger.ts`
- Console logging disabled by default (`DEBUG_MODE = false` in `logger.ts`); enable by setting `DEBUG_MODE = true` locally

## CI/CD & Deployment

**Hosting:**
- npm registry — published as `opencode-fallback` package
- Consumers install via: `npm install opencode-fallback` or `bun add opencode-fallback`

**CI Pipeline:**
- Not detected — no `.github/`, `.gitlab-ci.yml`, or CI config present

## Environment Configuration

**Required env vars:**
- `HOME` — used to resolve global config path (`~/.config/opencode/`) in `index.ts`
- No AI provider API keys — all handled by the host OpenCode application

**Secrets location:**
- None managed by this plugin

## OpenCode SDK Client API Surface Used

The plugin calls the following methods on `ctx.client` (typed in `PluginContext` in `types.ts`):

| Method | File | Purpose |
|--------|------|---------|
| `ctx.client.session.abort(...)` | `auto-retry.ts` | Abort an in-flight session request before fallback |
| `ctx.client.session.messages(...)` | `auto-retry.ts` | Fetch session message history to extract the last user message |
| `ctx.client.session.promptAsync(...)` | `auto-retry.ts` | Re-send the last user message with the fallback model |
| `ctx.client.session.get(...)` | `auto-retry.ts` | Resolve agent name from session metadata |
| `ctx.client.tui.showToast(...)` | `event-handler.ts` / `message-update-handler.ts` | Display toast notification on model switch |

## Webhooks & Callbacks

**Incoming:**
- Plugin hooks (from OpenCode's event system, not HTTP):
  - `event` hook: receives `message.updated` events and all other OpenCode events
  - `chat.message` hook: intercepts outbound chat messages for fallback injection
  - `config` hook: receives the full `opencode.json` config on plugin init

**Outgoing:**
- None — no outbound HTTP webhooks

---

*Integration audit: 2026-03-18*
