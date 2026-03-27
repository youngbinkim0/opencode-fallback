import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { logInfo, logError, getLogFilePath } from "./logger"
import { PLUGIN_NAME } from "./constants"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

describe("logger", () => {
	const logFile = getLogFilePath()
	let originalContent: string | null = null

	beforeEach(() => {
		// Preserve existing log content
		if (existsSync(logFile)) {
			originalContent = readFileSync(logFile, "utf-8")
		}
		// Truncate for clean test
		writeFileSync(logFile, "")
	})

	afterEach(() => {
		// Restore original content
		if (originalContent !== null) {
			writeFileSync(logFile, originalContent)
		}
	})

	describe("#given getLogFilePath", () => {
		test("#then returns a path under ~/.config/opencode/", () => {
			const path = getLogFilePath()
			expect(path).toContain(".config")
			expect(path).toContain("opencode")
			expect(path).toContain("opencode-fallback.log")
		})
	})

	describe("#given logInfo", () => {
		test("#then writes INFO level to log file", () => {
			logInfo("Test info message")

			const content = readFileSync(logFile, "utf-8")
			expect(content).toContain("[INFO]")
			expect(content).toContain(`[${PLUGIN_NAME}]`)
			expect(content).toContain("Test info message")
		})

		test("#then includes context when provided", () => {
			logInfo("Test with context", { sessionID: "ses_123", model: "test/model" })

			const content = readFileSync(logFile, "utf-8")
			expect(content).toContain("ses_123")
			expect(content).toContain("test/model")
		})

		test("#then includes ISO timestamp", () => {
			logInfo("Timestamp test")

			const content = readFileSync(logFile, "utf-8")
			// ISO timestamp format: 2026-03-27T...
			expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/)
		})

		test("#then writes without context when none provided", () => {
			logInfo("No context")

			const content = readFileSync(logFile, "utf-8")
			expect(content).toContain("No context")
			// Should end with just the message and newline, no JSON object
			const line = content.trim()
			expect(line.endsWith("No context")).toBe(true)
		})
	})

	describe("#given logError", () => {
		test("#then writes ERROR level to log file", () => {
			logError("Test error message")

			const content = readFileSync(logFile, "utf-8")
			expect(content).toContain("[ERROR]")
			expect(content).toContain(`[${PLUGIN_NAME}]`)
			expect(content).toContain("Test error message")
		})

		test("#then includes context when provided", () => {
			logError("Error with context", { error: "something broke", sessionID: "ses_err" })

			const content = readFileSync(logFile, "utf-8")
			expect(content).toContain("something broke")
			expect(content).toContain("ses_err")
		})
	})

	describe("#given multiple log calls", () => {
		test("#then each call appends a new line", () => {
			logInfo("Line 1")
			logInfo("Line 2")
			logError("Line 3")

			const content = readFileSync(logFile, "utf-8")
			const lines = content.trim().split("\n")
			expect(lines.length).toBe(3)
			expect(lines[0]).toContain("Line 1")
			expect(lines[1]).toContain("Line 2")
			expect(lines[2]).toContain("Line 3")
		})
	})
})
