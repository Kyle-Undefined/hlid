import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { WHISPER_ASSETS, WHISPER_ASSETS_HASH } from "./voice-assets";

const RUNTIME_LAYOUT_VERSION = "wav-shim-v2";

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

async function materializeEmbeddedFile(
	source: string,
	destination: string,
): Promise<void> {
	await Bun.write(destination, Bun.file(source));
}

export async function bootstrapVoiceRuntime(): Promise<string | null> {
	const override = process.env.HLID_WHISPER_SERVER;
	if (override) return override;
	if (!WHISPER_ASSETS) return null;
	const local =
		process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local";
	const dir = join(local, "hlid", "whisper-rt");
	const hashFile = join(dir, ".hash");
	const runtimeHash = `${WHISPER_ASSETS_HASH}-${RUNTIME_LAYOUT_VERSION}`;
	if (
		existsSync(hashFile) &&
		readFileSync(hashFile, "utf8").trim() === runtimeHash &&
		existsSync(join(dir, "whisper-server.exe")) &&
		existsSync(join(dir, "ffmpeg.cmd"))
	) {
		return join(dir, "whisper-server.exe");
	}
	const tempDir = `${dir}.tmp`;
	rmSync(tempDir, { recursive: true, force: true });
	mkdirSync(tempDir, { recursive: true });
	for (const [name, source] of Object.entries(WHISPER_ASSETS)) {
		const destination = join(tempDir, name);
		mkdirSync(dirname(destination), { recursive: true });
		await materializeEmbeddedFile(source, destination);
	}
	writeFileSync(join(tempDir, "ffmpeg.cmd"), FFMPEG_WAV_SHIM, "utf8");
	writeFileSync(join(tempDir, ".hash"), runtimeHash, "utf8");
	try {
		renameSync(tempDir, dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EEXIST") {
			throw error;
		}
		rmSync(dir, { recursive: true, force: true });
		renameSync(tempDir, dir);
	}
	return join(dir, "whisper-server.exe");
}
