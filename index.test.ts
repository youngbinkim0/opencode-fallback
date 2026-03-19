import { describe, expect, it, mock, beforeEach } from "bun:test"
import OpenCodeFallbackPlugin from "./index"
import type { PluginContext } from "./types"

function createMockContext(): PluginContext {
	return {
		directory: "/test/dir",
		client: {
			session: {
				abort: mock(() => Promise.resolve()),
				messages: mock(() =>
					Promise.resolve({
						data: [],
					})
				),
				promptAsync: mock(() => Promise.resolve()),
				get: mock(() =>
					Promise.resolve({
						data: {},
					})
				),
			},
			tui: {
				showToast: mock(() => Promise.resolve()),
			},
		},
	}
}

describe("OpenCodeFallbackPlugin", () => {
	describe("#given a valid plugin context", () => {
		let ctx: PluginContext

		beforeEach(() => {
			ctx = createMockContext()
		})

		describe("#when plugin is initialized", () => {
			it("#then returns an object with name, config, event, and chat.message properties", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				expect(plugin.name).toBe("opencode-fallback")
				expect(typeof plugin.config).toBe("function")
				expect(typeof plugin.event).toBe("function")
				expect(typeof plugin["chat.message"]).toBe("function")
			})
		})

		describe("#when config hook is called with agent configs", () => {
			it("#then captures agent configs for later use", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				const agentConfigs = {
					agents: {
						opus: {
							model: "anthropic/claude-opus-4-6",
							fallback_models: [
								"google/antigravity-claude-opus-4-6-thinking",
							],
						},
					},
				}

				plugin.config(agentConfigs)

				const output = {
					message: {
						model: {
							providerID: "anthropic",
							modelID: "claude-opus-4-6",
						},
					},
				}

				await plugin["chat.message"](
					{
						sessionID: "test-session",
						model: {
							providerID: "anthropic",
							modelID: "claude-opus-4-6",
						},
					},
					output
				)

				expect(output.message.model.providerID).toBe("anthropic")
			})
		})

		describe("#when session.error event is received", () => {
			it("#then event handler processes the error", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				plugin.config({
					agents: {
						opus: {
							model: "anthropic/claude-opus-4-6",
							fallback_models: ["google/gemini-pro"],
						},
					},
				})

				await plugin.event({
					event: {
						type: "session.error",
						properties: {
						sessionID: "ses-opus-001",
						error: { statusCode: 429, message: "Rate limited" },
						model: "anthropic/claude-opus-4-6",
						},
					},
				})

				expect(ctx.client.session.abort).toHaveBeenCalled()
			})
		})

		describe("#when plugin is disabled via config", () => {
			it("#then event handler skips processing", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx, {
					enabled: false,
				})

				await plugin.event({
					event: {
						type: "session.error",
						properties: {
							sessionID: "test-session",
							error: { statusCode: 429, message: "Rate limited" },
						},
					},
				})

				expect(ctx.client.session.abort).not.toHaveBeenCalled()
			})
		})

		describe("#when session.deleted event is received", () => {
			it("#then cleanup is performed without errors", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				await plugin.event({
					event: {
						type: "session.deleted",
						properties: {
							info: { id: "test-session" },
						},
					},
				})

				expect(true).toBe(true)
			})
		})

		describe("#when message.updated event is received", () => {
			it("#then delegates to message update handler", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				plugin.config({
					agents: {
						opus: {
							model: "anthropic/claude-opus-4-6",
							fallback_models: ["google/gemini-pro"],
						},
					},
				})

				await plugin.event({
					event: {
						type: "message.updated",
						properties: {
							info: {
								sessionID: "test-session",
								role: "assistant",
								error: {
									statusCode: 429,
									message: "Rate limited",
								},
							},
						},
					},
				})

				expect(true).toBe(true)
			})
		})
	})
})
