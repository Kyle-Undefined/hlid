import { spawn } from "node:child_process";

export type MicrosoftSpeechVoice = {
	id: string;
	name: string;
	language: string;
	gender: string;
	default: boolean;
};

type PowerShellOptions = {
	timeoutMs: number;
	maxOutputBytes: number;
};

export type PowerShellRunner = (
	script: string,
	input: string,
	options: PowerShellOptions,
) => Promise<Uint8Array>;

const VOICE_CACHE_MS = 5 * 60_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

const VOICES_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
  $default = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice
  $voices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
    [pscustomobject]@{
      id = $_.Id
      name = $_.DisplayName
      language = $_.Language
      gender = [string]$_.Gender
      default = ($default -and $_.Id -eq $default.Id)
    }
  })
  $json = ConvertTo-Json -Compress -InputObject $voices
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;

const SYNTHESIZE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
  $synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
  if ($payload.voiceId) {
    $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
      Where-Object { $_.Id -eq $payload.voiceId } |
      Select-Object -First 1
    if (-not $voice) { throw 'The selected Microsoft speech voice is unavailable' }
    $synth.Voice = $voice
  }
  $operation = $synth.SynthesizeTextToStreamAsync([string]$payload.text)
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($operation))
  $task.Wait()
  $speechStream = $task.Result
  $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($speechStream)
  $memory = [IO.MemoryStream]::new()
  $netStream.CopyTo($memory)
  $bytes = $memory.ToArray()
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
  $memory.Dispose()
  $netStream.Dispose()
  $speechStream.Dispose()
  $synth.Dispose()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;

function encodedCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

export const runPowerShell: PowerShellRunner = (script, input, options) =>
	new Promise((resolve, reject) => {
		const child = spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				encodedCommand(script),
			],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let stderr = "";
		let settled = false;
		const finish = (error?: Error, output?: Uint8Array) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(output ?? new Uint8Array());
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error("Microsoft speech synthesis timed out"));
		}, options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > options.maxOutputBytes) {
				child.kill();
				finish(new Error("Microsoft speech output exceeded the size limit"));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 8_192) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code !== 0) {
				finish(
					new Error(
						stderr.trim() || "Microsoft speech synthesis is unavailable",
					),
				);
				return;
			}
			finish(undefined, Buffer.concat(chunks));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input, "utf8");
	});

function isWave(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 12) return false;
	return (
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WAVE"
	);
}

export class MicrosoftSpeechManager {
	private voiceCache: { value: MicrosoftSpeechVoice[]; at: number } | null =
		null;

	constructor(private readonly runner: PowerShellRunner = runPowerShell) {}

	async voices(refresh = false): Promise<MicrosoftSpeechVoice[]> {
		if (
			!refresh &&
			this.voiceCache &&
			Date.now() - this.voiceCache.at < VOICE_CACHE_MS
		)
			return this.voiceCache.value;
		const output = await this.runner(VOICES_SCRIPT, "", {
			timeoutMs: 5_000,
			maxOutputBytes: 256 * 1024,
		});
		const parsed = JSON.parse(Buffer.from(output).toString("utf8")) as unknown;
		if (!Array.isArray(parsed))
			throw new Error("Microsoft voice inventory was invalid");
		const voices = parsed.filter(
			(value): value is MicrosoftSpeechVoice =>
				typeof value === "object" &&
				value !== null &&
				typeof (value as MicrosoftSpeechVoice).id === "string" &&
				typeof (value as MicrosoftSpeechVoice).name === "string" &&
				typeof (value as MicrosoftSpeechVoice).language === "string" &&
				typeof (value as MicrosoftSpeechVoice).gender === "string" &&
				typeof (value as MicrosoftSpeechVoice).default === "boolean",
		);
		if (voices.length === 0)
			throw new Error("No Microsoft speech voices found");
		this.voiceCache = { value: voices, at: Date.now() };
		return voices;
	}

	// fallow-ignore-next-line unused-class-member -- Called through the structural speech dependency in readAloudRoutes.
	async synthesize(text: string, voiceId: string): Promise<Uint8Array> {
		if (voiceId) {
			const voices = await this.voices();
			if (!voices.some((voice) => voice.id === voiceId))
				throw new Error("The selected Microsoft speech voice is unavailable");
		}
		const output = await this.runner(
			SYNTHESIZE_SCRIPT,
			JSON.stringify({ text, voiceId }),
			{ timeoutMs: 30_000, maxOutputBytes: MAX_AUDIO_BYTES },
		);
		if (!isWave(output))
			throw new Error("Microsoft speech returned invalid audio");
		return output;
	}
}
