export {}

await Bun.build({
	entrypoints: ["./index.ts"],
	outdir: "./dist",
	target: "bun",
	format: "esm",
	external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
	define: { __FALLBACK_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
})

const proc = Bun.spawn(["tsc", "--emitDeclarationOnly", "--project", "tsconfig.json"])
await proc.exited
