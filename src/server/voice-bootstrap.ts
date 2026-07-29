import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	materializeEmbeddedFile,
	stageRuntimeDirectory,
	verifyRuntimeDirectory,
} from "./embeddedRuntime";
import { WHISPER_ASSETS, WHISPER_ASSETS_HASH } from "./voice-assets";

const RUNTIME_LAYOUT_VERSION = "wav-shim-v3-vulkan";

// whisper.cpp v1.8.x's server has an upstream bug in the direct multipart WAV
// path. Its --convert path correctly materializes the upload before decoding,
// but normally requires FFmpeg. Hlid only sends canonical 16 kHz mono PCM WAV,
// so this local shim safely copies input to output for that conversion step.
const FFMPEG_WAV_SHIM = `@echo off
if "%~1"=="-version" exit /b 0
set "input="
set "output="
:loop
if "%~1"=="" goto done
if "%~1"=="-i" goto capture_input
set "output=%~1"
shift
goto loop
:capture_input
shift
set "input=%~1"
set "output=%~1"
shift
goto loop
:done
if not defined input exit /b 2
if not defined output exit /b 2
copy /Y "%input%" "%output%" >nul
`;

export function existingVoiceRuntime(
	directory: string,
	runtimeHash: string,
	requiredFiles: readonly string[],
): string | null {
	const executable = join(directory, "whisper-server.exe");
	return verifyRuntimeDirectory(directory, runtimeHash, [
		"whisper-server.exe",
		"ffmpeg.cmd",
		...requiredFiles,
	])
		? executable
		: null;
}

export async function bootstrapVoiceRuntime(): Promise<string | null> {
	const override = process.env.HLID_WHISPER_SERVER;
	if (override) return override;
	const assets = WHISPER_ASSETS;
	if (!assets) return null;
	const local =
		process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local";
	const dir = join(local, "hlid", "whisper-rt");
	const runtimeHash = `${WHISPER_ASSETS_HASH}-${RUNTIME_LAYOUT_VERSION}`;
	const requiredFiles = Object.keys(assets);
	const existingRuntime = existingVoiceRuntime(dir, runtimeHash, requiredFiles);
	if (existingRuntime) return existingRuntime;
	await stageRuntimeDirectory(dir, runtimeHash, async (tempDir) => {
		for (const [name, source] of Object.entries(assets)) {
			const destination = join(tempDir, name);
			mkdirSync(dirname(destination), { recursive: true });
			await materializeEmbeddedFile(source, destination);
		}
		writeFileSync(join(tempDir, "ffmpeg.cmd"), FFMPEG_WAV_SHIM, "utf8");
	});
	return join(dir, "whisper-server.exe");
}
