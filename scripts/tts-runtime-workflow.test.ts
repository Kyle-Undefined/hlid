import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
	DIRECTML_NUGET_SHA256,
	DIRECTML_VERSION,
	ONNXRUNTIME_NUGET_SHA256,
	ONNXRUNTIME_VERSION,
	SHERPA_DIRECTML_PATCH_SHA256,
	SHERPA_NPM_ARCHIVE_SHA256,
	SHERPA_SOURCE_COMMIT,
	SHERPA_VERSION,
	TTS_RUNTIME_BUILD_FLAGS,
	TTS_RUNTIME_ID,
	TTS_RUNTIME_LICENSE_PATHS,
} from "./tts-runtime-artifact";

type WorkflowStep = {
	name?: string;
	uses?: string;
	run?: string;
	"timeout-minutes"?: number;
	with?: Record<string, unknown>;
};

type WorkflowJob = {
	permissions?: Record<string, string>;
	"runs-on"?: string;
	uses?: string;
	with?: Record<string, unknown>;
	needs?: string | string[];
	steps?: WorkflowStep[];
};

type Workflow = {
	name: string;
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	env: Record<string, string>;
	jobs: Record<string, WorkflowJob>;
};

function readWorkflow(name: string): { parsed: Workflow; source: string } {
	const source = readFileSync(
		resolve(import.meta.dirname, "..", ".github", "workflows", name),
		"utf8",
	);
	return { parsed: load(source) as Workflow, source };
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
	const step = job.steps?.find((candidate) => candidate.name === name);
	if (!step) throw new Error(`workflow step not found: ${name}`);
	return step;
}

describe("TTS DirectML runtime workflow", () => {
	it("keeps manual candidates ephemeral and gates releases on qualified bytes", () => {
		const { parsed: runtime } = readWorkflow("tts-runtime.yml");
		const { parsed: release } = readWorkflow("release.yml");
		const build = runtime.jobs.build;

		expect(runtime.name).toBe("Build TTS DirectML runtime");
		expect(Object.keys(runtime.on).sort()).toEqual([
			"workflow_call",
			"workflow_dispatch",
		]);
		expect(runtime.permissions).toEqual({});
		expect(runtime.env.RUNTIME_ID).toBe(TTS_RUNTIME_ID);
		expect(Object.keys(runtime.jobs)).toEqual(["build"]);
		expect(build["runs-on"]).toBe("windows-2022");
		expect(build.permissions).toEqual({ contents: "read" });
		const checkout = namedStep(build, "Checkout Hlid");
		expect(checkout.with?.clean).toBe(true);
		expect(checkout.with?.["persist-credentials"]).toBe(false);
		for (const step of build.steps ?? []) {
			if (step.uses) expect(step.uses).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
		}
		expect(release.jobs["tts-runtime"]).toMatchObject({
			needs: "validate",
			uses: "./.github/workflows/tts-runtime.yml",
			with: { require_qualified: true },
			permissions: { contents: "read" },
		});
		expect(release.jobs.build.needs).toContain("tts-runtime");

		const upload = namedStep(build, "Upload the runtime artifact");
		expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
		expect(upload.with?.name).toBe("${{ env.TTS_ARTIFACT_NAME }}");
		expect(upload.with?.path).toBe("${{ runner.temp }}\\hlid-tts-artifact");
		expect(upload.with?.["retention-days"]).toBe(7);
		expect(upload.with?.["if-no-files-found"]).toBe("error");

		const executableSteps = build.steps?.map((step) => step.run ?? "").join("\n");
		for (const forbidden of [
			"gh release",
			"git push",
			"npm publish",
			"softprops/action-gh-release",
			"upload-release-asset",
		]) {
			expect(executableSteps?.toLowerCase()).not.toContain(forbidden);
		}
	});

	it("pins every external binary input and the exact sherpa source correction", () => {
		const { parsed: runtime } = readWorkflow("tts-runtime.yml");
		const build = runtime.jobs.build;
		expect(runtime.env.SHERPA_VERSION).toBe(SHERPA_VERSION);
		expect(runtime.env.SHERPA_SOURCE_COMMIT).toBe(SHERPA_SOURCE_COMMIT);
		expect(runtime.env.SHERPA_NPM_SHA256).toBe(SHERPA_NPM_ARCHIVE_SHA256);
		expect(runtime.env.ONNXRUNTIME_VERSION).toBe(ONNXRUNTIME_VERSION);
		expect(runtime.env.ONNXRUNTIME_NUGET_SHA256).toBe(
			ONNXRUNTIME_NUGET_SHA256,
		);
		expect(runtime.env.DIRECTML_VERSION).toBe(DIRECTML_VERSION);
		expect(runtime.env.DIRECTML_NUGET_SHA256).toBe(DIRECTML_NUGET_SHA256);

		const inputs = namedStep(build, "Download and verify pinned binary inputs");
		expect(inputs.run).toContain("Get-FileHash $entry.Key -Algorithm SHA256");
		expect(inputs.run).toContain("registry.npmjs.org/sherpa-onnx-win-x64");
		expect(inputs.run).toContain("Microsoft.ML.OnnxRuntime.DirectML");
		expect(inputs.run).toContain("Microsoft.AI.DirectML");

		const source = namedStep(build, "Checkout and patch pinned sherpa source");
		expect(source.run).toContain("clone --no-checkout --filter=blob:none");
		expect(source.run).toContain("checkout --detach $env:SHERPA_SOURCE_COMMIT");
		expect(source.run).toContain('.Replace("`r`n", "`n")');
		expect(source.run).toContain("[System.Text.UTF8Encoding]::new($false)");
		expect(source.run).toContain(SHERPA_DIRECTML_PATCH_SHA256);
		expect(source.run).toContain("git -C $source apply --check $patch");
		expect(source.run).toContain("git -C $source diff --check");
		expect(source.run).toContain(
			'if ($LASTEXITCODE -ne 0) { throw "Pinned sherpa patch does not apply cleanly" }',
		);
		expect(source.run).toContain(
			'if ($LASTEXITCODE -ne 0) { throw "Patched sherpa source failed git diff --check" }',
		);
		expect(source.run).toContain(
			'$changedFiles[0] -ne "cmake/onnxruntime.cmake"',
		);
	});

	it("builds only the C API and audits the staged runtime before packaging", () => {
		const { parsed: runtime } = readWorkflow("tts-runtime.yml");
		const build = runtime.jobs.build;
		const configure = namedStep(build, "Configure the DirectML-capable C API");
		for (const flag of TTS_RUNTIME_BUILD_FLAGS) {
			expect(configure.run).toContain(`"-D${flag}"`);
		}
		expect(configure.run).toContain("$configureArguments = @(");
		expect(configure.run).toContain('"Visual Studio 17 2022"');
		expect(configure.run).toContain('"x64"');
		expect(configure.run).toContain('"v143"');
		expect(configure.run).toContain(
			'"-DCMAKE_SYSTEM_VERSION=10.0.26100.0"',
		);
		expect(configure.run).toContain("cmake @configureArguments");

		const compile = namedStep(build, "Build only the sherpa C API");
		expect(compile.run).toContain("--target sherpa-onnx-c-api");
		const stage = namedStep(build, "Stage binaries, licenses, and notices");
		for (const license of TTS_RUNTIME_LICENSE_PATHS) {
			expect(stage.run).toContain(`"${license}"`);
		}
		const audit = namedStep(build, "Audit architecture and dependencies");
		expect(audit.run).toContain("machine \\(x64\\)");
		expect(audit.run).toContain("sherpa-onnx-c-api\\.dll");
		expect(audit.run).toContain("onnxruntime\\.dll");
		expect(audit.run).toContain("links a vendor driver or build-time GPU tool");
	});

	it("CPU-smokes every build and requires qualified bytes for a release", () => {
		const { parsed: runtime } = readWorkflow("tts-runtime.yml");
		const build = runtime.jobs.build;
		const model = namedStep(build, "Download and verify the CPU smoke model");
		expect(model["timeout-minutes"]).toBe(7);
		expect(model.run).toContain("curl.exe --fail --location --retry 3");
		expect(model.run).toContain("--connect-timeout 30 --max-time 300");
		expect(model.run).toContain("Get-FileHash $archive -Algorithm SHA256");
		expect(model.run).toContain("Get-Command 7z.exe -ErrorAction Stop");
		expect(model.run).toContain('& $sevenZip x -y "-o$modelRoot" $archive');
		expect(model.run).toContain(
			'& $sevenZip x -y "-o$modelRoot" $tarArchive',
		);
		expect(model.run).toContain('"TTS_SMOKE_MODEL=$model"');
		const smoke = namedStep(build, "CPU-smoke the candidate on the generic runner");
		expect(smoke["timeout-minutes"]).toBe(10);
		expect(smoke.run).toContain(
			"bun scripts/smoke-tts-runtime.ts $env:TTS_RUNTIME_ROOT $env:TTS_SMOKE_MODEL cpu",
		);
		const smokeScript = readFileSync(
			resolve(import.meta.dirname, "smoke-tts-runtime.ts"),
			"utf8",
		);
		expect(smokeScript).toContain("process.exit(0)");

		const packageStep = namedStep(
			build,
			"Package and self-verify the runtime",
		);
		expect(packageStep.run).toContain("package-tts-runtime.ps1");
		expect(packageStep.run).toContain(
			'if (-not $?) { throw "Failed to package the TTS runtime" }',
		);
		expect(packageStep.run).toContain("create-tts-runtime-manifest.ts");
		expect(packageStep.run).toContain(
			'$verifyArguments += "--require-qualified"',
		);
		expect(packageStep.run).toContain("bun @verifyArguments");
		expect(packageStep.run).toContain(
			'"TTS_ARTIFACT_NAME=$($env:RUNTIME_ID)"',
		);
		expect(packageStep.run).toContain(
			'"TTS_ARTIFACT_NAME=$($env:RUNTIME_ID)-unqualified"',
		);
		expect(packageStep.run).toContain(
			'if ($LASTEXITCODE -ne 0) { throw "Failed to create the TTS runtime manifest" }',
		);
		expect(packageStep.run).toContain(
			'if ($LASTEXITCODE -ne 0) { throw "TTS runtime self-verification failed" }',
		);
		const verifier = readFileSync(
			resolve(import.meta.dirname, "verify-tts-runtime.ts"),
			"utf8",
		);
		expect(verifier).toContain("cliArguments.length > 2");
		expect(verifier).toContain(
			'cliArguments[1] !== undefined && cliArguments[1] !== "--require-qualified"',
		);
	});

	it("publishes the qualified runtime beside the app with checksums", () => {
		const { parsed: release } = readWorkflow("release.yml");
		const releaseJob = release.jobs.release;
		const download = namedStep(releaseJob, "Download qualified DirectML runtime");
		expect(download.uses).toMatch(
			/^actions\/download-artifact@[a-f0-9]{40}$/,
		);
		expect(download.with?.name).toBe(TTS_RUNTIME_ID);
		expect(download.with?.path).toBe("dist/");

		const checksums = namedStep(releaseJob, "Generate checksums");
		expect(checksums.run).toContain(
			"sha256sum *.exe *.zip runtime-manifest.json > hlid-checksums.txt",
		);
		const publish = namedStep(releaseJob, "Publish release");
		expect(publish.with?.files).toContain("dist/*.zip");
		expect(publish.with?.files).toContain("dist/runtime-manifest.json");
	});

	it("packages a strict deterministic archive outside the runtime tree", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "package-tts-runtime.ps1"),
			"utf8",
		);
		expect(source).toContain("-Attributes ReparsePoint");
		expect(source).toContain(".ProviderPath.TrimEnd");
		expect(source).toContain("OutputArchive must be outside RuntimeRoot");
		expect(source).toContain('"package/$relative"');
		expect(source).toContain("2000, 1, 1, 0, 0, 0");
		expect(source).toContain("exceeds the 32 MiB limit");
		expect(source).toContain("unqualified candidate runtime files");
	});
});
