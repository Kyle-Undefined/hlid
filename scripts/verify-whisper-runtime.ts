import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	verifyRuntimeArtifact,
	WHISPER_RUNTIME_ARTIFACT,
} from "./bundle-whisper-assets";

const artifactDirectory = process.argv[2];
if (!artifactDirectory) {
	throw new Error(
		"usage: bun scripts/verify-whisper-runtime.ts <artifact-directory>",
	);
}

const resolved = resolve(artifactDirectory);
if (!lstatSync(resolved).isDirectory()) {
	throw new Error(`whisper runtime artifact must be a directory: ${resolved}`);
}
const expected = [WHISPER_RUNTIME_ARTIFACT, "runtime-manifest.json"].sort();
const actual = readdirSync(resolved).sort();
if (
	actual.length !== expected.length ||
	actual.some((entry, index) => entry !== expected[index])
) {
	throw new Error("whisper runtime artifact contains unexpected or missing files");
}
await verifyRuntimeArtifact(
	join(resolved, WHISPER_RUNTIME_ARTIFACT),
	join(resolved, "runtime-manifest.json"),
);

console.log(`Verified reviewed whisper runtime artifact at ${resolved}`);
