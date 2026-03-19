import type { MessagePart, ReplayTier, ReplayResult } from "./types"

const TIER_2_TYPES = new Set(["text", "image"])

export function filterPartsByTier(parts: MessagePart[], tier: ReplayTier): MessagePart[] {
	switch (tier) {
		case 1:
			return parts
		case 2:
			return parts.filter((p) => TIER_2_TYPES.has(p.type))
		case 3:
			return parts.filter((p) => p.type === "text")
	}
}

export async function replayWithDegradation(
	allParts: MessagePart[],
	sendFn: (parts: MessagePart[]) => Promise<void>
): Promise<ReplayResult> {
	if (allParts.length === 0) {
		return { success: false, error: "No parts to replay" }
	}

	const tiers: ReplayTier[] = [1, 2, 3]
	let lastError: unknown
	let previousLength = -1

	for (const tier of tiers) {
		const filtered = filterPartsByTier(allParts, tier)

		// Skip empty or duplicate tiers
		if (filtered.length === 0) continue
		if (filtered.length === previousLength) continue
		previousLength = filtered.length

		try {
			await sendFn(filtered)

			// Compute dropped types
			const sentTypes = new Set(filtered.map((p) => p.type))
			const allTypes = new Set(allParts.map((p) => p.type))
			const droppedTypes = [...allTypes].filter((t) => !sentTypes.has(t))

			return {
				success: true,
				tier,
				sentParts: filtered,
				droppedTypes,
			}
		} catch (err) {
			lastError = err
		}
	}

	return {
		success: false,
		error: lastError instanceof Error ? lastError.message : String(lastError),
	}
}
