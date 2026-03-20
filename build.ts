export {}

await Bun.build({
	entrypoints: ["./index.ts"],
	outdir: "./dist",
	target: "node",
	format: "cjs",
	external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
})

const proc = Bun.spawn(["tsc", "--emitDeclarationOnly", "--project", "tsconfig.json"])
await proc.exited
