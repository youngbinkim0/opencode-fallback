import { describe, test, expect, mock } from "bun:test"
import { filterPartsByTier, replayWithDegradation } from "./message-replay"
import type { MessagePart } from "./types"

const textPart: MessagePart = { type: "text", text: "hello world" }
const imagePart: MessagePart = { type: "image", url: "https://example.com/img.png" }
const toolResultPart: MessagePart = { type: "tool_result", text: "result data" }
const filePart: MessagePart = { type: "file", path: "/tmp/test.txt" }

const mixedParts: MessagePart[] = [textPart, imagePart, toolResultPart, filePart]
const textAndImageParts: MessagePart[] = [textPart, imagePart]
const textOnlyParts: MessagePart[] = [textPart]

describe("message-replay", () => {
	describe("#given filterPartsByTier", () => {
		describe("#when tier is 1 (all parts)", () => {
			test("#then returns all parts unchanged", () => {
				const result = filterPartsByTier(mixedParts, 1)
				expect(result).toEqual(mixedParts)
				expect(result.length).toBe(4)
			})
		})

		describe("#when tier is 2 (text + image)", () => {
			test("#then returns only text and image parts", () => {
				const result = filterPartsByTier(mixedParts, 2)
				expect(result.length).toBe(2)
				expect(result[0].type).toBe("text")
				expect(result[1].type).toBe("image")
			})
		})

		describe("#when tier is 3 (text only)", () => {
			test("#then returns only text parts", () => {
				const result = filterPartsByTier(mixedParts, 3)
				expect(result.length).toBe(1)
				expect(result[0].type).toBe("text")
			})
		})

		describe("#when parts is empty", () => {
			test("#then returns empty array for any tier", () => {
				expect(filterPartsByTier([], 1)).toEqual([])
				expect(filterPartsByTier([], 2)).toEqual([])
				expect(filterPartsByTier([], 3)).toEqual([])
			})
		})

		describe("#when parts contain only text", () => {
			test("#then all tiers return the same text parts", () => {
				const t1 = filterPartsByTier(textOnlyParts, 1)
				const t2 = filterPartsByTier(textOnlyParts, 2)
				const t3 = filterPartsByTier(textOnlyParts, 3)
				expect(t1).toEqual(textOnlyParts)
				expect(t2).toEqual(textOnlyParts)
				expect(t3).toEqual(textOnlyParts)
			})
		})

		describe("#when parts contain text and image only", () => {
			test("#then tier 1 and tier 2 return the same parts", () => {
				const t1 = filterPartsByTier(textAndImageParts, 1)
				const t2 = filterPartsByTier(textAndImageParts, 2)
				expect(t1).toEqual(textAndImageParts)
				expect(t2).toEqual(textAndImageParts)
			})

			test("#then tier 3 returns only text", () => {
				const t3 = filterPartsByTier(textAndImageParts, 3)
				expect(t3.length).toBe(1)
				expect(t3[0].type).toBe("text")
			})
		})
	})

	describe("#given replayWithDegradation", () => {
		describe("#when sendFn succeeds on first call (Tier 1)", () => {
			test("#then returns success with tier 1 and no dropped types", async () => {
				const sendFn = mock(async (_parts: MessagePart[]) => {})

				const result = await replayWithDegradation(mixedParts, sendFn)

				expect(result.success).toBe(true)
				expect(result.tier).toBe(1)
				expect(result.sentParts).toEqual(mixedParts)
				expect(result.droppedTypes).toEqual([])
				expect(sendFn).toHaveBeenCalledTimes(1)
			})
		})

		describe("#when sendFn rejects Tier 1 but accepts Tier 2", () => {
			test("#then returns success with tier 2 and reports dropped types", async () => {
				let callCount = 0
				const sendFn = mock(async (parts: MessagePart[]) => {
					callCount++
					// Reject tier 1 (all parts), accept tier 2 (text + image)
					if (parts.length > 2) {
						throw new Error("Unsupported part types")
					}
				})

				const result = await replayWithDegradation(mixedParts, sendFn)

				expect(result.success).toBe(true)
				expect(result.tier).toBe(2)
				expect(result.sentParts?.length).toBe(2)
				expect(result.droppedTypes).toContain("tool_result")
				expect(result.droppedTypes).toContain("file")
				expect(sendFn).toHaveBeenCalledTimes(2)
			})
		})

		describe("#when sendFn rejects Tier 1 and 2 but accepts Tier 3", () => {
			test("#then returns success with tier 3 and reports all non-text types as dropped", async () => {
				let callCount = 0
				const sendFn = mock(async (parts: MessagePart[]) => {
					callCount++
					// Only accept text-only parts
					if (parts.some((p) => p.type !== "text")) {
						throw new Error("Unsupported part types")
					}
				})

				const result = await replayWithDegradation(mixedParts, sendFn)

				expect(result.success).toBe(true)
				expect(result.tier).toBe(3)
				expect(result.sentParts?.length).toBe(1)
				expect(result.droppedTypes).toContain("image")
				expect(result.droppedTypes).toContain("tool_result")
				expect(result.droppedTypes).toContain("file")
			})
		})

		describe("#when sendFn rejects all tiers", () => {
			test("#then returns failure with last error message", async () => {
				const sendFn = mock(async (_parts: MessagePart[]) => {
					throw new Error("Always fails")
				})

				const result = await replayWithDegradation(mixedParts, sendFn)

				expect(result.success).toBe(false)
				expect(result.error).toBe("Always fails")
				expect(result.tier).toBeUndefined()
				expect(result.sentParts).toBeUndefined()
			})
		})

		describe("#when parts array is empty", () => {
			test("#then returns failure without calling sendFn", async () => {
				const sendFn = mock(async (_parts: MessagePart[]) => {})

				const result = await replayWithDegradation([], sendFn)

				expect(result.success).toBe(false)
				expect(result.error).toBe("No parts to replay")
				expect(sendFn).not.toHaveBeenCalled()
			})
		})

		describe("#when message is text-only and sendFn rejects", () => {
			test("#then sendFn is called only once (duplicate tiers skipped)", async () => {
				const sendFn = mock(async (_parts: MessagePart[]) => {
					throw new Error("Rejected")
				})

				const result = await replayWithDegradation(textOnlyParts, sendFn)

				expect(result.success).toBe(false)
				// Tiers 1, 2, 3 all produce length 1 for text-only — only tier 1 calls sendFn
				expect(sendFn).toHaveBeenCalledTimes(1)
			})
		})

		describe("#when message is text+image and sendFn rejects Tier 1", () => {
			test("#then tier 2 is skipped (same parts as tier 1) and tier 3 is tried", async () => {
				let callCount = 0
				const sendFn = mock(async (parts: MessagePart[]) => {
					callCount++
					// Reject unless text-only
					if (parts.some((p) => p.type !== "text")) {
						throw new Error("Rejected")
					}
				})

				const result = await replayWithDegradation(textAndImageParts, sendFn)

				expect(result.success).toBe(true)
				expect(result.tier).toBe(3)
				// Tier 1 = 2 parts, Tier 2 = 2 parts (skipped, same length), Tier 3 = 1 part
				expect(sendFn).toHaveBeenCalledTimes(2)
			})
		})

		describe("#when parts have no text parts (non-text only)", () => {
			test("#then attempts Tier 1 and fails gracefully if rejected", async () => {
				const nonTextParts: MessagePart[] = [imagePart, toolResultPart]
				const sendFn = mock(async (_parts: MessagePart[]) => {
					throw new Error("No text content")
				})

				const result = await replayWithDegradation(nonTextParts, sendFn)

				expect(result.success).toBe(false)
				// Tier 1 = 2 parts, Tier 2 = 1 (image), Tier 3 = 0 (skipped)
				expect(sendFn).toHaveBeenCalledTimes(2)
			})
		})

		describe("#when sendFn throws a non-Error object", () => {
			test("#then error is stringified", async () => {
				const sendFn = mock(async (_parts: MessagePart[]) => {
					throw "string error"
				})

				const result = await replayWithDegradation(textOnlyParts, sendFn)

				expect(result.success).toBe(false)
				expect(result.error).toBe("string error")
			})
		})

		describe("#when parts contain unknown types not in any tier set", () => {
			test("#then tier 1 tries all, tier 2 drops unknowns, tier 3 drops unknowns and images", async () => {
				const unknownParts: MessagePart[] = [
					{ type: "custom_widget", data: "widget-data" },
					{ type: "audio", url: "audio.mp3" },
				]
				const callHistory: number[] = []
				const sendFn = mock(async (parts: MessagePart[]) => {
					callHistory.push(parts.length)
					throw new Error("Rejected")
				})

				const result = await replayWithDegradation(unknownParts, sendFn)

				expect(result.success).toBe(false)
				// Tier 1: 2 parts (all), Tier 2: 0 parts (skipped — no text/image), Tier 3: 0 parts (skipped — no text)
				// Only 1 call because tiers 2 and 3 produce empty arrays
				expect(callHistory).toEqual([2])
			})
		})

		describe("#when parts have empty string type", () => {
			test("#then empty type is treated as unknown (filtered out in tier 2 and 3)", () => {
				const emptyTypeParts: MessagePart[] = [{ type: "", data: "something" }]
				const t1 = filterPartsByTier(emptyTypeParts, 1)
				const t2 = filterPartsByTier(emptyTypeParts, 2)
				const t3 = filterPartsByTier(emptyTypeParts, 3)
				expect(t1.length).toBe(1)
				expect(t2.length).toBe(0)
				expect(t3.length).toBe(0)
			})
		})

		describe("#when sendFn throws undefined", () => {
			test("#then error is stringified as 'undefined'", async () => {
				const sendFn = mock(async (_parts: MessagePart[]) => {
					throw undefined
				})

				const result = await replayWithDegradation(textOnlyParts, sendFn)

				expect(result.success).toBe(false)
				expect(result.error).toBe("undefined")
			})
		})

		describe("#when sendFn throws null", () => {
			test("#then error is stringified as 'null'", async () => {
				const sendFn = mock(async (_parts: MessagePart[]) => {
					throw null
				})

				const result = await replayWithDegradation(textOnlyParts, sendFn)

				expect(result.success).toBe(false)
				expect(result.error).toBe("null")
			})
		})

		describe("#when all parts are images (no text)", () => {
			test("#then tier 2 includes them, tier 3 produces empty", async () => {
				const imageOnlyParts: MessagePart[] = [
					{ type: "image", url: "img1.png" },
					{ type: "image", url: "img2.png" },
				]
				const sendFn = mock(async (_parts: MessagePart[]) => {})

				const result = await replayWithDegradation(imageOnlyParts, sendFn)

				// Tier 1 succeeds (same as tier 2 for image-only)
				expect(result.success).toBe(true)
				expect(result.tier).toBe(1)
				expect(result.sentParts?.length).toBe(2)
				expect(result.droppedTypes).toEqual([])
			})
		})

		describe("#when tier 1 and 2 have same length but tier 3 succeeds", () => {
			test("#then tier 2 is skipped and tier 3 is the second attempt", async () => {
				// text + image = 2 parts in both tier 1 and tier 2
				const parts: MessagePart[] = [textPart, imagePart]
				let callCount = 0
				const sendFn = mock(async (p: MessagePart[]) => {
					callCount++
					if (p.some((x) => x.type !== "text")) throw new Error("No images!")
				})

				const result = await replayWithDegradation(parts, sendFn)

				expect(result.success).toBe(true)
				expect(result.tier).toBe(3)
				// Only 2 calls: tier 1 (rejected), tier 2 skipped (same length), tier 3 (accepted)
				expect(callCount).toBe(2)
				expect(result.droppedTypes).toContain("image")
			})
		})

		describe("#when multiple text parts exist", () => {
			test("#then all text parts survive to tier 3", async () => {
				const multiText: MessagePart[] = [
					{ type: "text", text: "part 1" },
					{ type: "text", text: "part 2" },
					{ type: "text", text: "part 3" },
					{ type: "image", url: "img.png" },
				]

				const t3 = filterPartsByTier(multiText, 3)
				expect(t3.length).toBe(3)
				expect(t3.every((p) => p.type === "text")).toBe(true)
			})
		})
	})
})
