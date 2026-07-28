import { resolve } from "node:path";
import { verifyRuntimeTree } from "./bundle-whisper-assets";

const runtimeRoot = process.argv[2];
if (!runtimeRoot) {
	throw new Error("usage: bun scripts/verify-whisper-runtime.ts <runtime-root>");
}

const resolved = resolve(runtimeRoot);
if (!verifyRuntimeTree(resolved)) {
	throw new Error(`whisper runtime does not match the reviewed manifest: ${resolved}`);
}

console.log(`Verified reviewed whisper runtime at ${resolved}`);
