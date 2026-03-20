export {}

await Bun.build({
	entrypoints: ["./index.ts"],
	outdir: "./dist",
	target: "bun",
	format: "esm",
	external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
})

const proc = Bun.spawn(["tsc", "--emitDeclarationOnly", "--project", "tsconfig.json"])
await proc.exited
