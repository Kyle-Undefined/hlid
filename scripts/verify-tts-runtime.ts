import { resolve } from "node:path";
import {
	artifactPath,
	assertTtsArtifactDirectory,
	manifestPath,
	verifyTtsRuntimeArtifact,
} from "./tts-runtime-artifact";

const cliArguments = process.argv.slice(2);
const artifactDirectory = cliArguments[0];
if (
	!artifactDirectory ||
	cliArguments.length > 2 ||
	(cliArguments[1] !== undefined && cliArguments[1] !== "--require-qualified")
)
	throw new Error(
		"usage: bun scripts/verify-tts-runtime.ts <artifact-directory> [--require-qualified]",
	);
const requireQualified = cliArguments[1] === "--require-qualified";

const resolved = resolve(artifactDirectory);
assertTtsArtifactDirectory(resolved);
await verifyTtsRuntimeArtifact(artifactPath(resolved), manifestPath(resolved), {
	requireQualified,
});
console.log(
	`Verified ${requireQualified ? "qualified" : "unqualified candidate"} TTS runtime at ${resolved}`,
);
