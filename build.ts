export {}
import { rm, readdir } from "node:fs/promises"

// All dist files are generated; remove obsolete split chunks before packing.
await rm("./dist", { recursive: true, force: true })

const result = await Bun.build({
	entrypoints: ["./index.ts", "./v1.ts", "./v2.ts", "./tui.ts", "./fallback-rpc.ts"],
	outdir: "./dist",
	target: "bun",
	format: "esm",
	splitting: true,
	external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opencode/plugin"],
	define: { __FALLBACK_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
})
if (!result.success) {
	console.error(result.logs)
	process.exit(1)
}

const proc = Bun.spawn(["tsc", "--emitDeclarationOnly", "--project", "tsconfig.json"])
const status = await proc.exited
if (status !== 0) process.exit(status)
for (const name of await readdir("./dist")) {
	if (name.endsWith(".integration.d.ts")) await rm(`./dist/${name}`)
}
