import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { existingVoiceRuntime } from "./voice-bootstrap";

const tempDirs: string[] = [];

function runtimeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hlid-voice-runtime-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("existingVoiceRuntime", () => {
	it("requires the current hash, WAV shim, and every reviewed runtime asset", () => {
		const dir = runtimeDir();
		const files = [
			"whisper-server.exe",
			"ggml.dll",
			"ggml-base.dll",
			"ggml-cpu.dll",
			"ggml-vulkan.dll",
			"whisper.dll",
			"LICENSE",
		];
		for (const file of files) writeFileSync(join(dir, file), file);
		writeFileSync(join(dir, "ffmpeg.cmd"), "shim");
		writeFileSync(join(dir, ".hash"), "reviewed-layout");

		expect(existingVoiceRuntime(dir, "reviewed-layout", files)).toBe(
			join(dir, "whisper-server.exe"),
		);
	});

	it("rejects a runtime missing the reviewed upstream license", () => {
		const dir = runtimeDir();
		for (const file of [
			"whisper-server.exe",
			"ggml.dll",
			"ggml-base.dll",
			"ggml-cpu.dll",
			"ggml-vulkan.dll",
			"whisper.dll",
		])
			writeFileSync(join(dir, file), file);
		writeFileSync(join(dir, "ffmpeg.cmd"), "shim");
		writeFileSync(join(dir, ".hash"), "reviewed-layout");

		expect(
			existingVoiceRuntime(dir, "reviewed-layout", [
				"whisper-server.exe",
				"ggml.dll",
				"ggml-base.dll",
				"ggml-cpu.dll",
				"ggml-vulkan.dll",
				"whisper.dll",
				"LICENSE",
			]),
		).toBeNull();
	});

	it("rejects a stale CPU-only runtime even when its hash file matches", () => {
		const dir = runtimeDir();
		for (const file of [
			"whisper-server.exe",
			"ggml.dll",
			"ggml-base.dll",
			"ggml-cpu.dll",
			"whisper.dll",
		])
			writeFileSync(join(dir, file), file);
		writeFileSync(join(dir, "ffmpeg.cmd"), "shim");
		writeFileSync(join(dir, ".hash"), "reviewed-layout");

		expect(
			existingVoiceRuntime(dir, "reviewed-layout", [
				"whisper-server.exe",
				"ggml.dll",
				"ggml-base.dll",
				"ggml-cpu.dll",
				"ggml-vulkan.dll",
				"whisper.dll",
			]),
		).toBeNull();
	});
});
