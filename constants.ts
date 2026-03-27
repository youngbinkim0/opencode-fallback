import type { FallbackPluginConfig } from "./types"

export const PLUGIN_NAME = "opencode-fallback"

export const DEFAULT_CONFIG: Required<FallbackPluginConfig> = {
	enabled: true,
	retry_on_errors: [429, 500, 502, 503, 504],
	retryable_error_patterns: [],
	max_fallback_attempts: 3,
	cooldown_seconds: 60,
	timeout_seconds: 30,
	notify_on_fallback: true,
	fallback_models: [],
}

export const RETRYABLE_ERROR_PATTERNS = [
	/rate.?limit/i,
	/too.?many.?requests/i,
	/quota.?exceeded/i,
	/quota.?protection/i,
	/key.?limit.?exceeded/i,
	/usage\s+limit\s+has\s+been\s+reached/i,
	/service.?unavailable/i,
	/overloaded/i,
	/temporarily.?unavailable/i,
	/try.?again/i,
	/credit.*balance.*too.*low/i,
	/insufficient.?(?:credits?|funds?|balance)/i,
	/(?:^|\s)429(?:\s|$)/,
	/(?:^|\s)503(?:\s|$)/,
	/(?:^|\s)529(?:\s|$)/,
]
