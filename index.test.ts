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
			command: mock(() => Promise.resolve()),
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

		describe("#when config hook is called with singular 'agent' key", () => {
			it("#then captures agent configs from singular key", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				const opencodeConfig = {
					agent: {
						opus: {
							model: "anthropic/claude-opus-4-6",
							fallback_models: ["google/gemini-pro"],
						},
					},
				}

				plugin.config(opencodeConfig)

				// Trigger a session.error to verify agent configs are accessible
				;(ctx.client.session.messages as any).mockImplementation(() =>
					Promise.resolve({
						data: [
							{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						],
					})
				)

				await plugin.event({
					event: {
						type: "session.error",
						properties: {
							sessionID: "ses-opus-singular",
							error: { statusCode: 429, message: "Rate limited" },
							model: "anthropic/claude-opus-4-6",
						},
					},
				})

				// If agent config was captured, fallback should proceed
				expect(ctx.client.session.promptAsync).toHaveBeenCalled()
			})
		})

		describe("#when config hook is called with non-object agents", () => {
			it("#then agentConfigs is set to undefined", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				plugin.config({ agents: "not-an-object" } as any)

				// Trigger session.error — no fallback models since no agent config
				await plugin.event({
					event: {
						type: "session.error",
						properties: {
							sessionID: "ses-bad-config",
							error: { statusCode: 429, message: "Rate limited" },
							model: "anthropic/claude-opus-4-6",
						},
					},
				})

				// No fallback — no agent configs
				expect(ctx.client.session.promptAsync).not.toHaveBeenCalled()
			})
		})

		describe("#when session.error event is received", () => {
			it("#then event handler processes the error without aborting (model already stopped)", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				plugin.config({
					agents: {
						opus: {
							model: "anthropic/claude-opus-4-6",
							fallback_models: ["google/gemini-pro"],
						},
					},
				})

				// Provide a user message so replay can proceed
				;(ctx.client.session.messages as any).mockImplementation(() =>
					Promise.resolve({
						data: [
							{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
						],
					})
				)

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

				// Model already stopped on error — abort is skipped
				expect(ctx.client.session.abort).not.toHaveBeenCalled()
				// Replay proceeds directly with fallback model
				expect(ctx.client.session.promptAsync).toHaveBeenCalled()
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

			it("#then replays from non-assistant context and ignores model-less stale session.error", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				plugin.config({
					agents: {
						planner: {
							model: "google/antigravity-claude-opus-4-6-thinking",
							fallback_models: [
								"anthropic/claude-opus-4-6",
								"github-copilot/gpt-5.3-codex",
							],
						},
					},
				})

				// Simulate a child session where no user message exists, but a non-assistant
				// replayable message does exist (tool/system-like context).
				;(ctx.client.session.messages as any).mockImplementation(() =>
					Promise.resolve({
						data: [
							{
								info: {
									role: "tool",
									sessionID: "ses_child_race",
								},
								parts: [{ type: "text", text: "tool context" }],
							},
							{
								info: {
									role: "assistant",
									sessionID: "ses_child_race",
									agent: "planner",
									model: "google/antigravity-claude-opus-4-6-thinking",
								},
								parts: [{ type: "text", text: "upstream failure" }],
							},
						],
					})
				)

				// First failure path via message.updated: should prepare fallback to anthropic.
				await plugin.event({
					event: {
						type: "message.updated",
						properties: {
							info: {
								sessionID: "ses_child_race",
								role: "assistant",
								agent: "planner",
								model: "google/antigravity-claude-opus-4-6-thinking",
								error: { statusCode: 429, message: "primary failed" },
							},
						},
					},
				})

				// Stale/late error path with no model field (mirrors observed logs).
				await plugin.event({
					event: {
						type: "session.error",
						properties: {
							sessionID: "ses_child_race",
							agent: "planner",
							error: { name: "UnknownError", message: "late stale error" },
						},
					},
				})

				// Must dispatch exactly one replay (to anthropic), and stale session.error
				// must NOT consume a second fallback attempt.
				expect(ctx.client.session.promptAsync).toHaveBeenCalledTimes(1)
				const promptArgs = (ctx.client.session.promptAsync as any).mock.calls[0][0]
				expect(promptArgs.body.model.providerID).toBe("anthropic")
				expect(promptArgs.body.model.modelID).toBe("claude-opus-4-6")
			})
		})

		describe("tool.execute.after", () => {
			it("#then replaces empty task result with fallback response when child completes", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)
				const childSessionID = "ses_child123abc"

				// Mock: child session goes idle and has an assistant response
				;(ctx.client.session.get as any).mockImplementation(() =>
					Promise.resolve({
						data: { status: "idle" },
					})
				)
				;(ctx.client.session.messages as any).mockImplementation(() =>
					Promise.resolve({
						data: [
							{ info: { role: "user" }, parts: [{ type: "text", text: "Do the task" }] },
							{ info: { role: "assistant" }, parts: [{ type: "text", text: "Here is the completed task result from fallback model." }] },
						],
					})
				)

				const input = {
					tool: "task",
					sessionID: "ses_parent456",
					callID: "call_001",
					args: {},
				}
				const output = {
					title: "Task",
					output: `task_id: ${childSessionID} (for resuming to continue this task if needed)\n\n<task_result>\n\n</task_result>`,
					metadata: {},
				}

				await plugin["tool.execute.after"](input, output)

				expect(output.output).toBe("Here is the completed task result from fallback model.")
			})

			it("#then waits while child has active fallback then replaces result", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)
				const childSessionID = "ses_waitchild"

				// Simulate: session.get returns idle immediately (event-driven
				// approach uses immediate status check as race protection)
				;(ctx.client.session.get as any).mockImplementation(() =>
					Promise.resolve({
						data: { status: "idle" },
					})
				)
				;(ctx.client.session.messages as any).mockImplementation(() =>
					Promise.resolve({
						data: [
							{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
							{ info: { role: "assistant" }, parts: [{ type: "text", text: "Fallback result after wait." }] },
						],
					})
				)

				const input = {
					tool: "task",
					sessionID: "ses_parent789",
					callID: "call_002",
					args: {},
				}
				const output = {
					title: "Task",
					output: `task_id: ${childSessionID} (for resuming...)\n\n<task_result>\n\n</task_result>`,
					metadata: {},
				}

				await plugin["tool.execute.after"](input, output)

				expect(output.output).toBe("Fallback result after wait.")
			})

			it("#then preserves original empty result on max-wait timeout", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx, { timeout_seconds: 1 })
				const childSessionID = "ses_timeoutchild"

				// Child never goes idle
				;(ctx.client.session.get as any).mockImplementation(() =>
					Promise.resolve({
						data: { status: "busy" },
					})
				)

				const input = {
					tool: "task",
					sessionID: "ses_parent_timeout",
					callID: "call_003",
					args: {},
				}
				const originalOutput = `task_id: ${childSessionID} (for resuming...)\n\n<task_result>\n\n</task_result>`
				const output = {
					title: "Task",
					output: originalOutput,
					metadata: {},
				}

				await plugin["tool.execute.after"](input, output)

				// Should preserve original since timeout
				expect(output.output).toBe(originalOutput)
			})

			it("#then does not modify non-task tool output", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				const input = {
					tool: "bash",
					sessionID: "ses_parent_bash",
					callID: "call_004",
					args: {},
				}
				const originalOutput = "some bash output"
				const output = {
					title: "Bash",
					output: originalOutput,
					metadata: {},
				}

				await plugin["tool.execute.after"](input, output)

				expect(output.output).toBe(originalOutput)
			})

			it("#then does not modify non-empty task result", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				const input = {
					tool: "task",
					sessionID: "ses_parent_nonempty",
					callID: "call_005",
					args: {},
				}
				const originalOutput = `task_id: ses_child999 (for resuming...)\n\n<task_result>\nActual content here\n</task_result>`
				const output = {
					title: "Task",
					output: originalOutput,
					metadata: {},
				}

				await plugin["tool.execute.after"](input, output)

				expect(output.output).toBe(originalOutput)
			})
		})

		describe("#when session.compacted event is received", () => {
			it("#then event handler processes compacted event without errors", async () => {
				const plugin = await OpenCodeFallbackPlugin(ctx)

				// session.compacted should be routed to the base event handler
				// without throwing — even with no active fallback state
				await plugin.event({
					event: {
						type: "session.compacted",
						properties: {
							sessionID: "ses-compacted-test",
						},
					},
				})

				// No crash — the event was dispatched and handled as a no-op
				expect(true).toBe(true)
			})
		})
	})
})
