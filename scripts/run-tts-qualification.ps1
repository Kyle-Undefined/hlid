<#
.SYNOPSIS
Runs isolated sherpa-onnx TTS qualification with process-scoped GPU monitoring.

.DESCRIPTION
Starts scripts/qualify-tts-model.ts in its own Bun process, captures stdout and
stderr, samples the Windows GPU Engine counters for that exact process ID, and
finalizes result.json. DirectML fails closed unless at least one process-scoped
GPU engine utilization sample is greater than zero.

The child uses one persistent model handle for exactly one cold synthesis, six
warm repetitions, and four production-sized chunks. The wrapper never launches
or restarts Hlid.

.EXAMPLE
pwsh -File scripts/run-tts-qualification.ps1 `
  -Kind vits -Backend directml -ModelId candidate-vits `
  -ModelArchiveSha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef `
  -RuntimeDir C:\runtime -ModelDir C:\models\candidate-vits `
  -OutputDir C:\results\candidate-vits-directml -ExpectedRuntimeVersion 1.13.4

.EXAMPLE
pwsh -File scripts/run-tts-qualification.ps1 -Help
#>
[CmdletBinding()]
param(
  [ValidateSet("vits", "kitten", "supertonic", "matcha")]
  [string]$Kind,

  [ValidateSet("cpu", "directml")]
  [string]$Backend,

  [string]$ModelId,
  [ValidatePattern('^[a-f0-9]{64}$')]
  [string]$ModelArchiveSha256,
  [string]$RuntimeDir,
  [string]$ModelDir,
  [string]$OutputDir,
  [string]$ExpectedRuntimeVersion,

  [ValidateRange(1, 32)]
  [int]$Threads = 4,

  [ValidateRange(0, 100000)]
  [int]$Speaker = 0,

  [Nullable[double]]$NoiseScale,
  [Nullable[double]]$NoiseScaleW,

  [ValidateRange(10, 3600)]
  [int]$TimeoutSeconds = 900,

  [string]$ModelFile,
  [string]$Vocoder,
  [string]$BunPath,
  [string]$QualificationScript,

  [Alias("h")]
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$Usage = @"
Usage:
  pwsh -File scripts/run-tts-qualification.ps1
    -Kind <vits|kitten|supertonic|matcha>
    -Backend <cpu|directml>
    -ModelId <candidate-id>
    -ModelArchiveSha256 <64 lowercase hex characters>
    -RuntimeDir <directory>
    -ModelDir <directory>
    -OutputDir <new-or-empty-directory>
    -ExpectedRuntimeVersion <version>
    [-Threads <1-32>] [-Speaker <zero-based-id>]
    [-NoiseScale <positive-number>] [-NoiseScaleW <positive-number>]
    [-TimeoutSeconds <10-3600>]
    [-ModelFile <path>] [-Vocoder <path>] [-BunPath <bun.exe>]

DirectML passes only when the child succeeds, representative.wav exists, and a
positive process-scoped Windows GPU Engine sample was captured. CPU runs do not
require GPU evidence. Outputs are result.json, representative.wav, stdout.log,
stderr.log, and gpu-counters.json.
"@

if ($Help) {
  Write-Output $Usage
  return
}

$required = [ordered]@{
  Kind = $Kind
  Backend = $Backend
  ModelId = $ModelId
  ModelArchiveSha256 = $ModelArchiveSha256
  RuntimeDir = $RuntimeDir
  ModelDir = $ModelDir
  OutputDir = $OutputDir
  ExpectedRuntimeVersion = $ExpectedRuntimeVersion
}
foreach ($entry in $required.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
    throw "Missing required parameter -$($entry.Key).`n`n$Usage"
  }
}
if ($Kind -eq "matcha" -and [string]::IsNullOrWhiteSpace($Vocoder)) {
  throw "-Vocoder is required when -Kind is matcha.`n`n$Usage"
}
if ($Kind -ne "matcha" -and -not [string]::IsNullOrWhiteSpace($Vocoder)) {
  throw "-Vocoder is only valid when -Kind is matcha.`n`n$Usage"
}
if ($Kind -eq "supertonic" -and -not [string]::IsNullOrWhiteSpace($ModelFile)) {
  throw "-ModelFile is not valid for the multi-file Supertonic layout.`n`n$Usage"
}
foreach ($noiseEntry in ([ordered]@{
  NoiseScale = $NoiseScale
  NoiseScaleW = $NoiseScaleW
}).GetEnumerator()) {
  if ($null -ne $noiseEntry.Value) {
    $noiseValue = [double]$noiseEntry.Value
    if ($Kind -ne "vits") {
      throw "-$($noiseEntry.Key) is only valid when -Kind is vits.`n`n$Usage"
    }
    if ([double]::IsNaN($noiseValue) -or [double]::IsInfinity($noiseValue) -or $noiseValue -le 0) {
      throw "-$($noiseEntry.Key) must be a positive finite number.`n`n$Usage"
    }
  }
}
if ($ModelId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
  throw "-ModelId must be a stable filename-safe identifier.`n`n$Usage"
}

function Resolve-ExistingFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is not a file: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).ProviderPath
}

function Resolve-ExistingDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label is not a directory: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).ProviderPath
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  [System.IO.File]::WriteAllText(
    $Path,
    $Value,
    [System.Text.UTF8Encoding]::new($false)
  )
}

function ConvertTo-ProcessArgument([string]$Value) {
  if ($Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes += 1
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append(('\' * ($backslashes * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

$runtime = Resolve-ExistingDirectory $RuntimeDir "Runtime directory"
$model = Resolve-ExistingDirectory $ModelDir "Model directory"
$scriptPath = if ([string]::IsNullOrWhiteSpace($QualificationScript)) {
  Join-Path $PSScriptRoot "qualify-tts-model.ts"
} else {
  $QualificationScript
}
$scriptPath = Resolve-ExistingFile $scriptPath "Qualification script"

$bun = if ([string]::IsNullOrWhiteSpace($BunPath)) {
  $command = Get-Command bun -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  $command.Source
} else {
  Resolve-ExistingFile $BunPath "Bun executable"
}

$output = [System.IO.Path]::GetFullPath($OutputDir)
if (Test-Path -LiteralPath $output) {
  if (-not (Test-Path -LiteralPath $output -PathType Container)) {
    throw "Output path is not a directory: $output"
  }
  if (@(Get-ChildItem -LiteralPath $output -Force).Count -ne 0) {
    throw "Output directory must be empty: $output"
  }
} else {
  New-Item -ItemType Directory -Path $output -Force | Out-Null
}
$output = (Resolve-Path -LiteralPath $output).ProviderPath

$stdoutPath = Join-Path $output "stdout.log"
$stderrPath = Join-Path $output "stderr.log"
$gpuPath = Join-Path $output "gpu-counters.json"
$resultPath = Join-Path $output "result.json"
$wavPath = Join-Path $output "representative.wav"

$arguments = [System.Collections.Generic.List[string]]::new()
$arguments.Add($scriptPath)
$arguments.Add("--kind")
$arguments.Add($Kind)
$arguments.Add("--backend")
$arguments.Add($Backend)
$arguments.Add("--model-id")
$arguments.Add($ModelId)
$arguments.Add("--model-archive-sha256")
$arguments.Add($ModelArchiveSha256)
$arguments.Add("--runtime-dir")
$arguments.Add($runtime)
$arguments.Add("--model-dir")
$arguments.Add($model)
$arguments.Add("--output-dir")
$arguments.Add($output)
$arguments.Add("--expected-runtime-version")
$arguments.Add($ExpectedRuntimeVersion)
$arguments.Add("--threads")
$arguments.Add([string]$Threads)
$arguments.Add("--speaker")
$arguments.Add([string]$Speaker)
if ($null -ne $NoiseScale) {
  $arguments.Add("--noise-scale")
  $arguments.Add(([double]$NoiseScale).ToString([System.Globalization.CultureInfo]::InvariantCulture))
}
if ($null -ne $NoiseScaleW) {
  $arguments.Add("--noise-scale-w")
  $arguments.Add(([double]$NoiseScaleW).ToString([System.Globalization.CultureInfo]::InvariantCulture))
}
if (-not [string]::IsNullOrWhiteSpace($ModelFile)) {
  $arguments.Add("--model-file")
  $arguments.Add((Resolve-ExistingFile $ModelFile "Model file"))
}
if (-not [string]::IsNullOrWhiteSpace($Vocoder)) {
  $arguments.Add("--vocoder")
  $arguments.Add((Resolve-ExistingFile $Vocoder "Vocoder"))
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $bun
$startInfo.WorkingDirectory = $output
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.EnvironmentVariables["HLID_TTS_QUALIFICATION_MONITORED"] = "1"
if ($startInfo.PSObject.Properties.Name -contains "ArgumentList") {
  foreach ($argument in $arguments) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
} else {
  $startInfo.Arguments = (($arguments | ForEach-Object {
    ConvertTo-ProcessArgument $_
  }) -join " ")
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) {
  throw "Failed to start the isolated TTS qualification process"
}
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()

$samples = [System.Collections.Generic.List[object]]::new()
$counterErrors = [System.Collections.Generic.List[string]]::new()
$timedOut = $false
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
while (-not $process.HasExited) {
  if ([DateTimeOffset]::UtcNow -ge $deadline) {
    $timedOut = $true
    try {
      $process.Kill($true)
    } catch {
      $process.Kill()
    }
    break
  }
  if ($Backend -eq "directml") {
    $counterPath = "\GPU Engine(pid_$($process.Id)_*)\Utilization Percentage"
    try {
      $counter = Get-Counter -Counter $counterPath -ErrorAction Stop
      foreach ($sample in $counter.CounterSamples) {
        $samples.Add([pscustomobject]@{
          timestamp = [DateTimeOffset]::UtcNow.ToString("o")
          path = [string]$sample.Path
          value = [double]$sample.CookedValue
        })
      }
    } catch {
      $message = $_.Exception.Message
      if ($counterErrors.Count -lt 10 -and -not $counterErrors.Contains($message)) {
        $counterErrors.Add($message)
      }
    }
  }
  Start-Sleep -Milliseconds 100
  $process.Refresh()
}
$process.WaitForExit()
$process.Refresh()
$childExitCode = [int]$process.ExitCode
$stdoutText = $stdoutTask.GetAwaiter().GetResult()
$stderrText = $stderrTask.GetAwaiter().GetResult()
Write-Utf8NoBom $stdoutPath $stdoutText
Write-Utf8NoBom $stderrPath $stderrText

$engineSamples = @($samples)
$computeSamples = @($engineSamples | Where-Object { $_.path -match "engtype_Compute" })
$positiveCompute = @($computeSamples | Where-Object { $_.value -gt 0 })
$positiveAny = @($engineSamples | Where-Object { $_.value -gt 0 })
$positivePaths = @($positiveAny | Select-Object -ExpandProperty path -Unique)
$gpuSummary = [ordered]@{
  required = $Backend -eq "directml"
  pid = $process.Id
  childExitCode = $childExitCode
  timedOut = $timedOut
  counterAvailable = $engineSamples.Count -gt 0
  sampleRecords = $engineSamples.Count
  computeSampleRecords = $computeSamples.Count
  positiveComputeRecords = $positiveCompute.Count
  positiveAnyEngineRecords = $positiveAny.Count
  maxComputePercent = if ($computeSamples.Count -gt 0) {
    [math]::Round(($computeSamples | Measure-Object -Property value -Maximum).Maximum, 6)
  } else { 0 }
  maxAnyEnginePercent = if ($engineSamples.Count -gt 0) {
    [math]::Round(($engineSamples | Measure-Object -Property value -Maximum).Maximum, 6)
  } else { 0 }
  positiveEnginePaths = $positivePaths
  counterErrors = @($counterErrors)
  samples = $engineSamples
}
Write-Utf8NoBom $gpuPath (($gpuSummary | ConvertTo-Json -Depth 8) + "`n")

$failureReasons = [System.Collections.Generic.List[string]]::new()
if ($timedOut) {
  $failureReasons.Add("qualification exceeded the $TimeoutSeconds second timeout")
}
if ($childExitCode -ne 0) {
  $failureReasons.Add("qualification child exited with code $childExitCode")
}
if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
  $failureReasons.Add("qualification child did not write result.json")
}
if (-not (Test-Path -LiteralPath $wavPath -PathType Leaf)) {
  $failureReasons.Add("qualification child did not write representative.wav")
} elseif ((Get-Item -LiteralPath $wavPath).Length -eq 0) {
  $failureReasons.Add("qualification child wrote an empty representative.wav")
}
if ($Backend -eq "directml" -and $positiveAny.Count -eq 0) {
  $failureReasons.Add(
    "DirectML qualification observed no positive process-scoped Windows GPU Engine samples"
  )
}

$result = $null
if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
  try {
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  } catch {
    $failureReasons.Add("result.json is invalid JSON: $($_.Exception.Message)")
  }
}
if ($null -eq $result) {
  $result = [pscustomobject]@{
    schemaVersion = 1
    status = "failed"
    modelId = $ModelId
    kind = $Kind
    backend = $Backend
    process = [pscustomobject]@{ pid = $process.Id }
    runtime = [pscustomobject]@{
      directory = $runtime
      expectedVersion = $ExpectedRuntimeVersion
    }
    model = [pscustomobject]@{
      archiveSha256 = $ModelArchiveSha256
      directory = $model
      speaker = $Speaker
    }
    failedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
}

$passed = $failureReasons.Count -eq 0
$qualification = [pscustomobject]@{
  passed = $passed
  gpuEvidenceRequired = $Backend -eq "directml"
  failureReasons = @($failureReasons)
  gpuEvidenceFile = $gpuPath
  gpuEvidence = [pscustomobject]@{
    sampleRecords = $engineSamples.Count
    positiveAnyEngineRecords = $positiveAny.Count
    positiveComputeRecords = $positiveCompute.Count
    maxAnyEnginePercent = $gpuSummary.maxAnyEnginePercent
    maxComputePercent = $gpuSummary.maxComputePercent
    positiveEnginePaths = $positivePaths
  }
}
$result | Add-Member -NotePropertyName qualification -NotePropertyValue $qualification -Force
$result.status = if ($passed) { "qualified" } else { "failed" }
if (-not $passed) {
  $result | Add-Member -NotePropertyName failedAt `
    -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString("o")) -Force
}
Write-Utf8NoBom $resultPath (($result | ConvertTo-Json -Depth 16) + "`n")

if ($stderrText) { [Console]::Error.Write($stderrText) }
Write-Output (Get-Content -LiteralPath $resultPath -Raw)
if (-not $passed) {
  [Console]::Error.WriteLine(($failureReasons -join "; "))
  exit 1
}
