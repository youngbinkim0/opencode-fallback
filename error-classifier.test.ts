import { describe, test, expect } from "bun:test"
import {
	isRetryableError,
	extractStatusCode,
	classifyErrorType,
	getErrorMessage,
	extractAutoRetrySignal,
	containsErrorContent,
	detectErrorInTextParts,
	extractErrorContentFromParts,
} from "./error-classifier"
import { DEFAULT_CONFIG } from "./constants"

describe("error-classifier", () => {
	describe("#given isRetryableError", () => {
		describe("#when error has retryable HTTP status codes", () => {
			test("#then returns true for 429", () => {
				const error = { statusCode: 429, message: "Too many requests" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for 500", () => {
				const error = { statusCode: 500, message: "Internal server error" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for 502", () => {
				const error = { statusCode: 502, message: "Bad gateway" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for 503", () => {
				const error = { statusCode: 503, message: "Service unavailable" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for 504", () => {
				const error = { statusCode: 504, message: "Gateway timeout" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})
		})

		describe("#when error has retryable message patterns", () => {
			test("#then returns true for rate limit messages", () => {
				const error = { message: "Rate limit exceeded, try again later" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for too many requests messages", () => {
				const error = { message: "Too many requests" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for quota exceeded messages", () => {
				const error = { message: "API quota exceeded for this project" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})
		})

		describe("#when error has quota protection messages", () => {
			test("#then returns true for 'Quota protection: All accounts are over usage'", () => {
				const error = {
					message: "Quota protection: All 5 account(s) are over 90% usage for claude. Quota resets in 11h 1m. Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable."
				}
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for simple 'quota protection' message", () => {
				const error = { message: "Quota protection triggered" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})
		})

		describe("#when error has model not supported message", () => {
			test("#then returns true for 'The requested model is not supported'", () => {
				const error = {
					name: "AI_APICallError",
					message: "The requested model is not supported"
				}
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})
		})

		describe("#when error has retryable error types", () => {
			test("#then returns true for missing_api_key", () => {
				const error = {
					name: "LoadAPIKeyError",
					message: "api key is missing from environment variable",
				}
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})

			test("#then returns true for model_not_found", () => {
				const error = {
					name: "UnknownError",
					message: "model not found: some-model",
				}
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
			})
		})

		describe("#when error is non-retryable", () => {
			test("#then returns false for 400", () => {
				const error = { statusCode: 400, message: "Bad request" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(false)
			})

			test("#then returns false for 401", () => {
				const error = { statusCode: 401, message: "Unauthorized" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(false)
			})

			test("#then returns false for 404", () => {
				const error = { statusCode: 404, message: "Not found" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(false)
			})
		})
	})

	describe("#given extractStatusCode", () => {
		describe("#when explicit status and message codes disagree", () => {
			test("#then prefers the explicit numeric status", () => {
				const error = {
					statusCode: 401,
					message: "OpenAI API error: 429 Too Many Requests",
				}

				expect(extractStatusCode(error)).toBe(401)
			})
		})

		describe("#when provider messages include unrelated numbers", () => {
			test("#then extracts the retry status code instead of unrelated counters", () => {
				const error = {
					message:
						"Attempt 2 of 5 failed with status 503 while contacting the provider",
				}

				expect(extractStatusCode(error)).toBe(503)
			})
		})

		describe("#when error has direct statusCode", () => {
			test("#then extracts the status code", () => {
				expect(extractStatusCode({ statusCode: 429 })).toBe(429)
			})
		})

		describe("#when error has status field", () => {
			test("#then extracts from status", () => {
				expect(extractStatusCode({ status: 503 })).toBe(503)
			})
		})

		describe("#when error has nested data.statusCode", () => {
			test("#then extracts from nested path", () => {
				expect(extractStatusCode({ data: { statusCode: 502 } })).toBe(502)
			})
		})

		describe("#when error has status code in message", () => {
			test("#then extracts from message text", () => {
				expect(extractStatusCode({ message: "Error: 429 rate limited" })).toBe(429)
			})
		})

		describe("#when error has no status code", () => {
			test("#then returns undefined", () => {
				expect(extractStatusCode({ message: "Some generic error" })).toBeUndefined()
			})
		})

		describe("#when error is null", () => {
			test("#then returns undefined", () => {
				expect(extractStatusCode(null)).toBeUndefined()
			})
		})
	})

	describe("#given classifyErrorType", () => {
		describe("#when provider payloads use real-world API-key failures", () => {
			test("#then classifies OpenAI incorrect key responses as invalid_api_key", () => {
				const error = {
					error: {
						message:
							"Incorrect API key provided: sk-bad. You can find your API key at https://platform.openai.com/account/api-keys.",
					},
				}

				expect(classifyErrorType(error)).toBe("invalid_api_key")
			})

			test("#then classifies Anthropic missing key responses as missing_api_key", () => {
				const error = {
					data: {
						error: {
							message: "x-api-key header is required",
						},
					},
				}

				expect(classifyErrorType(error)).toBe("missing_api_key")
			})

			test("#then classifies Google invalid key responses as invalid_api_key", () => {
				const error = {
					message: "API key not valid. Please pass a valid API key.",
				}

				expect(classifyErrorType(error)).toBe("invalid_api_key")
			})

			test("#then classifies wrapped provider model-not-found responses", () => {
				const error = {
					message: "OpenAI API error: The model `gpt-does-not-exist` does not exist",
				}

				expect(classifyErrorType(error)).toBe("model_not_found")
			})
		})

		describe("#when error indicates missing API key", () => {
			test("#then returns missing_api_key", () => {
				const error = {
					name: "LoadAPIKeyError",
					message: "api key is missing from environment variable",
				}
				expect(classifyErrorType(error)).toBe("missing_api_key")
			})
		})

		describe("#when error indicates invalid API key", () => {
			test("#then returns invalid_api_key", () => {
				const error = {
					message: "API key must be a string, got undefined",
				}
				expect(classifyErrorType(error)).toBe("invalid_api_key")
			})
		})

		describe("#when error indicates model not found", () => {
			test("#then returns model_not_found", () => {
				const error = {
					name: "UnknownError",
					message: "Model not found: claude-999",
				}
				expect(classifyErrorType(error)).toBe("model_not_found")
			})
		})

		describe("#when error is a generic error", () => {
			test("#then returns undefined", () => {
				expect(classifyErrorType({ message: "Something went wrong" })).toBeUndefined()
			})
		})
	})

	describe("#given getErrorMessage", () => {
		describe("#when nested provider errors disagree with wrapper messages", () => {
			test("#then prefers the nested provider error message", () => {
				const error = {
					message: "wrapper error",
					data: {
						message: "generic transport error",
						error: { message: "Incorrect API key provided" },
					},
				}

				expect(getErrorMessage(error)).toBe("incorrect api key provided")
			})
		})

		describe("#when message fields are malformed", () => {
			test("#then falls back safely for numeric message values", () => {
				expect(getErrorMessage({ message: 429 })).toContain("429")
			})

			test("#then normalizes whitespace-only messages to empty strings", () => {
				expect(getErrorMessage({ message: "   \n\t  " })).toBe("")
			})

			test("#then returns empty string for circular objects instead of throwing", () => {
				const circular: Record<string, unknown> = {}
				circular.self = circular

				expect(getErrorMessage(circular)).toBe("")
			})
		})

		describe("#when error is a string", () => {
			test("#then returns lowercase string", () => {
				expect(getErrorMessage("Rate Limit Exceeded")).toBe("rate limit exceeded")
			})
		})

		describe("#when error is an object with message", () => {
			test("#then returns lowercase message", () => {
				expect(getErrorMessage({ message: "Server Error" })).toBe("server error")
			})
		})

		describe("#when error is nested in data.error.message", () => {
			test("#then extracts nested message", () => {
				expect(
					getErrorMessage({ data: { error: { message: "Deep Error" } } })
				).toBe("deep error")
			})
		})

		describe("#when error is null", () => {
			test("#then returns empty string", () => {
				expect(getErrorMessage(null)).toBe("")
			})
		})

		describe("#when error input is adversarial", () => {
			test("#then handles undefined safely", () => {
				expect(getErrorMessage(undefined)).toBe("")
			})

			test("#then handles giant strings without truncation or throws", () => {
				const giant = "RATE LIMIT ".repeat(500)
				expect(getErrorMessage(giant)).toBe(giant.toLowerCase())
			})
		})
	})

	describe("#given extractAutoRetrySignal", () => {
		describe("#when info contains retrying and rate limit signals", () => {
			test("#then returns the signal", () => {
				const info = {
					status: "Retrying in 5 seconds",
					message: "Too many requests - quota exceeded",
				}
				const result = extractAutoRetrySignal(info)
				expect(result).toBeDefined()
				expect(result?.signal).toContain("Retrying in 5 seconds")
			})
		})

		describe("#when info has only retry signal without rate limit", () => {
			test("#then returns undefined (both patterns required)", () => {
				const info = {
					status: "Retrying in 5 seconds",
					message: "Normal operation",
				}
				expect(extractAutoRetrySignal(info)).toBeUndefined()
			})
		})

		describe("#when info has rate-limit language without retrying language", () => {
			test("#then returns undefined because every pattern is intentional", () => {
				const info = {
					status: "Rate limit encountered",
					message: "Too many requests - quota exceeded",
				}

				expect(extractAutoRetrySignal(info)).toBeUndefined()
			})
		})

		describe("#when info fields are present but non-string", () => {
			test("#then ignores them safely", () => {
				const info = {
					status: 429,
					message: { text: "Retrying in 5 seconds" },
					details: false,
				}

				expect(extractAutoRetrySignal(info as Record<string, unknown>)).toBeUndefined()
			})
		})

		describe("#when info is undefined", () => {
			test("#then returns undefined", () => {
				expect(extractAutoRetrySignal(undefined)).toBeUndefined()
			})
		})
	})

	describe("#given containsErrorContent", () => {
		describe("#when parts contain error type parts", () => {
			test("#then returns hasError true with message", () => {
				const parts = [
					{ type: "text", text: "Hello" },
					{ type: "error", text: "Something failed" },
				]
				const result = containsErrorContent(parts)
				expect(result.hasError).toBe(true)
				expect(result.errorMessage).toBe("Something failed")
			})
		})

		describe("#when parts have no error type", () => {
			test("#then returns hasError false", () => {
				const parts = [{ type: "text", text: "Normal response" }]
				expect(containsErrorContent(parts).hasError).toBe(false)
			})
		})

		describe("#when parts is undefined", () => {
			test("#then returns hasError false", () => {
				expect(containsErrorContent(undefined).hasError).toBe(false)
			})
		})

		describe("#when error parts exist without text payloads", () => {
			test("#then still reports structural error presence", () => {
				const result = containsErrorContent([{ type: "error" }])
				expect(result).toEqual({ hasError: true, errorMessage: undefined })
			})
		})
	})

	describe("#given detectErrorInTextParts", () => {
		describe("#when text parts contain missing API key error", () => {
			test("#then detects error type", () => {
				const parts = [
					{ type: "text", text: "api key is missing from environment variable" },
				]
				const result = detectErrorInTextParts([
					...parts,
					{ type: "text", text: "" },
				].map(p => ({ ...p, text: p.text || undefined })))

				expect(result.hasError).toBe(true)
				expect(result.errorType).toBe("missing_api_key")
			})
		})

		describe("#when text parts have no error patterns", () => {
			test("#then returns hasError false", () => {
				const parts = [{ type: "text", text: "Normal response text" }]
				expect(detectErrorInTextParts(parts).hasError).toBe(false)
			})
		})
	})

	describe("#given extractErrorContentFromParts", () => {
		describe("#when parts have error-type entries", () => {
			test("#then extracts error messages", () => {
				const parts = [
					{ type: "error", text: "Error 1" },
					{ type: "text", text: "OK" },
					{ type: "error", text: "Error 2" },
				]
				const result = extractErrorContentFromParts(parts)
				expect(result.hasError).toBe(true)
				expect(result.errorMessage).toBe("Error 1\nError 2")
			})
		})

		describe("#when parts have no errors", () => {
			test("#then returns hasError false", () => {
				const parts = [{ type: "text", text: "Normal" }]
				expect(extractErrorContentFromParts(parts).hasError).toBe(false)
			})
		})

		describe("#when error parts have no text payloads", () => {
			test("#then ignores them because this helper only extracts textual content", () => {
				const result = extractErrorContentFromParts([{ type: "error" }])
				expect(result).toEqual({ hasError: false })
			})
		})
	})

	describe("#given user-provided retryable_error_patterns", () => {
		describe("#when error matches a user pattern", () => {
			test("#then isRetryableError returns true", () => {
				const error = { message: "Custom vendor error: billing suspended" }
				const userPatterns = ["billing\\s+suspended"]
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, userPatterns)).toBe(true)
			})
		})

		describe("#when error does not match any user pattern", () => {
			test("#then falls through to default behavior", () => {
				const error = { statusCode: 404, message: "Not found" }
				const userPatterns = ["billing\\s+suspended"]
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, userPatterns)).toBe(false)
			})
		})

		describe("#when user patterns are empty", () => {
			test("#then behaves like no patterns", () => {
				const error = { statusCode: 404, message: "Not found" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, [])).toBe(false)
			})
		})

		describe("#when user patterns are undefined", () => {
			test("#then behaves like no patterns", () => {
				const error = { statusCode: 404, message: "Not found" }
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, undefined)).toBe(false)
			})
		})

		describe("#when user pattern is an invalid regex", () => {
			test("#then skips the invalid pattern gracefully", () => {
				const error = { message: "some error message" }
				const userPatterns = ["[invalid", "some\\s+error"]
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, userPatterns)).toBe(true)
			})
		})

			describe("#when user pattern matches case-insensitively", () => {
			test("#then returns true", () => {
				const error = { message: "CUSTOM_PROVIDER_LIMIT_REACHED" }
				const userPatterns = ["custom_provider_limit"]
				expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, userPatterns)).toBe(true)
			})
		})
	})

	describe("#given isRetryableError priority ordering", () => {
		test("#then missing_api_key classification wins even with non-retryable status", () => {
			const error = {
				statusCode: 401,
				data: { error: { message: "x-api-key header is required" } },
			}

			expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
		})

		test("#then retryable status beats a non-matching message", () => {
			const error = { statusCode: 503, message: "Unexpected upstream failure" }
			expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors)).toBe(true)
		})

		test("#then built-in retry patterns beat user patterns", () => {
			const error = { message: "Service temporarily unavailable, try again" }
			expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, ["never-match-this"])).toBe(true)
		})

		test("#then user patterns are the final fallback", () => {
			const error = { message: "Vendor circuit breaker opened for tenant 42" }
			const userPatterns = ["circuit breaker opened"]
			expect(isRetryableError(error, DEFAULT_CONFIG.retry_on_errors, userPatterns)).toBe(true)
		})
	})
})
