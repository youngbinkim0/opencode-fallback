# Technology Stack

**Analysis Date:** 2026-03-18

## Languages

**Primary:**
- TypeScript 5.7.3 - All source files (`.ts`) at repo root

**Secondary:**
- JSON / JSONC - Configuration files (`opencode.json`, plugin config files)

## Runtime

**Environment:**
- Bun (latest compatible with `bun-types@1.3.6`) — used for running, testing, and building

**Package Manager:**
- Bun (root project)
- Bun (`.opencode/` tooling workspace)
- Lockfile: `bun.lock` present in `.opencode/` (root project has no lockfile committed)

## Frameworks

**Core:**
- None — this is a library/plugin, not an application framework

**Testing:**
- Bun test runner (built-in) — `bun test` command; no separate test framework dependency

**Build/Dev:**
- Bun bundler — via `build.ts` using `Bun.build()` API
- TypeScript compiler (`tsc`) — declaration-only emit, invoked from `build.ts`

## Key Dependencies

**Critical:**
- `@opencode-ai/plugin` `^1.1.0` (peer dep) / `^1.1.19` (devDep) — Plugin lifecycle interface (`PluginContext`, hooks); provides the SDK client API the plugin calls
- `@opencode-ai/sdk` `1.2.27` — Transitively required by `@opencode-ai/plugin`; provides the typed OpenCode client
- `zod` `4.1.8` — Transitively required by `@opencode-ai/plugin`

**Infrastructure:**
- `bun-types` `1.3.6` — TypeScript type definitions for Bun APIs used in source code (global `setTimeout`, `setInterval`, `Bun.build`)
- `typescript` `^5.7.3` — Compiler for type checking and declaration generation

## Configuration

**Environment:**
- No `.env` files; the plugin reads configuration from JSON/JSONC files on disk
- Config file search order (first match wins):
  1. `<project>/.opencode/opencode-fallback.json`
  2. `<project>/.opencode/opencode-fallback.jsonc`
  3. `~/.config/opencode/opencode-fallback.json`
  4. `~/.config/opencode/opencode-fallback.jsonc`
- `HOME` env var used to resolve global config path (`process.env.HOME`)

**Build:**
- `tsconfig.json` — target `ESNext`, module `ESNext`, `moduleResolution: bundler`, strict mode, declaration emit to `dist/`
- `build.ts` — Bun bundler entry: `entrypoints: ["./index.ts"]`, `outdir: "./dist"`, `target: "bun"`, `format: "esm"`, externals: `@opencode-ai/plugin`, `@opencode-ai/sdk`
- Output: `dist/index.js` (ESM) + `dist/*.d.ts` (TypeScript declarations)

## Platform Requirements

**Development:**
- Bun runtime required (no Node.js support — build script uses `Bun.build()` and `Bun.spawn()`)
- TypeScript compiler (`tsc`) available in PATH (used for declaration emit in `build.ts`)

**Production:**
- Distributed as an npm package (`dist/` directory published)
- Consumed by OpenCode's plugin loader (Bun-based)
- Peer dependency: `@opencode-ai/plugin >= 1.1.0`
- No external runtime services required — operates entirely within the OpenCode process

---

*Stack analysis: 2026-03-18*
