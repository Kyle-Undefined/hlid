param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot,

  [Parameter(Mandatory = $true)]
  [string]$OutputArchive
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression

$files = @(
  "ggml-base.dll",
  "ggml-cpu.dll",
  "ggml-vulkan.dll",
  "ggml.dll",
  "whisper.dll",
  "whisper-server.exe",
  "LICENSE"
)
$release = Join-Path $RuntimeRoot "Release"
$output = [System.IO.Path]::GetFullPath($OutputArchive)
$outputDirectory = Split-Path $output -Parent
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Remove-Item $output -Force -ErrorAction SilentlyContinue

$stream = [System.IO.File]::Open(
  $output,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::None
)
try {
  $archive = [System.IO.Compression.ZipArchive]::new(
    $stream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  try {
    foreach ($name in $files) {
      $source = Join-Path $release $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing reviewed runtime file: $source"
      }
      $entry = $archive.CreateEntry(
        "Release/$name",
        [System.IO.Compression.CompressionLevel]::Optimal
      )
      $entry.LastWriteTime = [System.DateTimeOffset]::new(
        2000,
        1,
        1,
        0,
        0,
        0,
        [System.TimeSpan]::Zero
      )
      $input = [System.IO.File]::OpenRead($source)
      $entryStream = $entry.Open()
      try {
        $input.CopyTo($entryStream)
      } finally {
        $entryStream.Dispose()
        $input.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $stream.Dispose()
}

$hash = (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Packaged deterministic runtime archive: $output"
Write-Host "SHA-256: $hash"
