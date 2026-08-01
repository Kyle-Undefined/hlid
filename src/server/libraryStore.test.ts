import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { LIBRARY_DIR, pathStartsWith } from "../lib/paths";
import {
	artifactPath,
	managedSkillsDirectory,
	planStagingPath,
	safeLibrarySegment,
	storageKey,
	visualizationStagingDirectory,
	visualizationStagingJobDirectory,
} from "./libraryStore";

describe("libraryStore", () => {
	it("keeps artifact and staging paths under the Hlid library", () => {
		const artifact = artifactPath("relic-1", "report.html");
		const plan = planStagingPath("session-1");
		const visualization = visualizationStagingJobDirectory("job-1");
		expect(pathStartsWith(LIBRARY_DIR, artifact)).toBe(true);
		expect(pathStartsWith(LIBRARY_DIR, plan)).toBe(true);
		expect(pathStartsWith(LIBRARY_DIR, visualization)).toBe(true);
		expect(dirname(visualization)).toBe(visualizationStagingDirectory());
		expect(storageKey(artifact)).toBe("artifacts/relic-1/report.html");
	});

	it("sanitizes path separators and traversal segments", () => {
		expect(safeLibrarySegment("../../secret name.md")).toBe("secret_name.md");
		const path = artifactPath("../outside", "../payload.txt");
		expect(pathStartsWith(LIBRARY_DIR, path)).toBe(true);
		expect(basename(path)).toBe("payload.txt");
		expect(pathStartsWith(dirname(managedSkillsDirectory()), path)).toBe(true);
		expect(basename(visualizationStagingJobDirectory("../job one"))).toBe(
			"job_one",
		);
	});
});
