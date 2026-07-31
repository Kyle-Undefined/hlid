import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

type WorkflowStep = {
	name?: string;
	uses?: string;
	env?: Record<string, string>;
	run?: string;
};

type WorkflowJob = {
	if?: string;
	needs?: string | string[];
	permissions?: Record<string, string>;
	"runs-on"?: string;
	steps?: WorkflowStep[];
	uses?: string;
};

type Workflow = {
	jobs: Record<string, WorkflowJob>;
};

function workflow(name: string): Workflow {
	return load(
		readFileSync(resolve(import.meta.dirname, "..", ".github", "workflows", name), "utf8"),
	) as Workflow;
}

describe("automatic Whisper release workflow", () => {
	it("builds every release on the pinned toolchain", () => {
		const runtime = workflow("whisper-runtime.yml");
		const build = runtime.jobs.build;

		expect(Object.keys(runtime.jobs)).toEqual(["build"]);
		expect(build.needs).toBeUndefined();
		expect(build.if).toBeUndefined();
		expect(build["runs-on"]).toBe("windows-2022");
		expect(build.permissions).toEqual({ contents: "read" });
		const checkout = build.steps?.find(
			(step) => step.name === "Checkout the pinned whisper.cpp source",
		);
		expect(checkout?.run).toContain("core.autocrlf=false clone --no-checkout");
		expect(checkout?.run).toContain(
			"core.autocrlf=false checkout --detach $env:WHISPER_SOURCE_COMMIT",
		);
		expect(
			build.steps?.some(
				(step) => step.name === "Generate and verify the runtime manifest",
			),
		).toBe(true);
		const configure = build.steps?.find(
			(step) => step.name === "Configure the portable CPU and Vulkan runtime",
		);
		for (const flag of [
			"BUILD_SHARED_LIBS=ON",
			"GGML_BACKEND_DL=ON",
			"GGML_NATIVE=OFF",
			"GGML_CPU_ALL_VARIANTS=OFF",
			"GGML_VULKAN=ON",
			"GGML_VULKAN_RUN_TESTS=OFF",
			"WHISPER_BUILD_TESTS=OFF",
			"WHISPER_BUILD_EXAMPLES=ON",
			"WHISPER_BUILD_SERVER=ON",
			"WHISPER_CURL=OFF",
		]) {
			expect(configure?.run).toContain(`-D${flag}`);
		}
		const audit = build.steps?.find(
			(step) => step.name === "Stage and audit the portable runtime",
		);
		expect(audit?.run).toContain("dumpbin failed for");
	});

	it("runs automatically before the Hlid build and passes the verified pair", () => {
		const release = workflow("release.yml");
		const runtime = release.jobs["whisper-runtime"];
		const build = release.jobs.build;
		const buildStep = build.steps?.find((step) => step.name === "Build hlid.exe");

		expect(runtime.uses).toBe("./.github/workflows/whisper-runtime.yml");
		expect(runtime.permissions).toEqual({ contents: "read" });
		expect(build.needs).toEqual(["validate", "whisper-runtime"]);
		expect(buildStep?.env?.HLID_WHISPER_RUNTIME_ARCHIVE).toContain(
			"hlid-whisper-runtime-windows-x64-v1.9.1.zip",
		);
		expect(buildStep?.env?.HLID_WHISPER_RUNTIME_MANIFEST).toContain(
			"runtime-manifest.json",
		);
	});
});
