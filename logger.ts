import { PLUGIN_NAME } from "./constants"
import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const LOG_FILE = join(homedir(), ".config", "opencode", "opencode-fallback.log")

// Ensure directory exists
try {
	mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true })
} catch {
	// Directory might already exist
}

function writeToFile(level: string, message: string, context?: Record<string, unknown>): void {
	const timestamp = new Date().toISOString()
	const contextStr = context ? ` ${JSON.stringify(context)}` : ""
	const logLine = `[${timestamp}] [${level}] [${PLUGIN_NAME}] ${message}${contextStr}\n`
	
	try {
		appendFileSync(LOG_FILE, logLine)
	} catch {
		// Silently fail if can't write to file
	}
}

// Set to true to enable console logging (for debugging only)
const DEBUG_MODE = false

export function logInfo(message: string, context?: Record<string, unknown>): void {
	if (DEBUG_MODE) {
		const contextStr = context ? ` ${JSON.stringify(context)}` : ""
		console.log(`[${PLUGIN_NAME}] ${message}${contextStr}`)
	}
	writeToFile("INFO", message, context)
}

export function logError(message: string, context?: Record<string, unknown>): void {
	if (DEBUG_MODE) {
		const contextStr = context ? ` ${JSON.stringify(context)}` : ""
		console.error(`[${PLUGIN_NAME}] ${message}${contextStr}`)
	}
	writeToFile("ERROR", message, context)
}

export function getLogFilePath(): string {
	return LOG_FILE
}
