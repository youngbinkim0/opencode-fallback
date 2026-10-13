import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import type { FallbackPluginConfig } from "./types"
import { logInfo } from "./logger"
import { PLUGIN_NAME } from "./constants"

export function loadPluginConfig<T extends FallbackPluginConfig = FallbackPluginConfig>(directory: string): Partial<T> {
	const paths = [
		join(directory, ".opencode", "opencode-fallback.jsonc"),
		join(directory, ".opencode", "opencode-fallback.json"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.jsonc"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-fallback.json"),
	]
	for (const path of paths) {
		if (!existsSync(path)) continue
		try {
			return parseJsonc(readFileSync(path, "utf-8")) as Partial<T>
		} catch (error) {
			logInfo(`[${PLUGIN_NAME}] Failed to parse config: ${path}`, { error: String(error) })
		}
	}
	return {}
}
