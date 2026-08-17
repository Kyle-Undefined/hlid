param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot,

  [Parameter(Mandatory = $true)]
  [string]$OutputArchive
)

$ErrorActionPreference = "Stop"

$runtime = (Resolve-Path -LiteralPath $RuntimeRoot).ProviderPath.TrimEnd("\", "/")
if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
  throw "RuntimeRoot must be a directory: $runtime"
}

$reparsePoints = @(Get-ChildItem -LiteralPath $runtime -Recurse -Force -Attributes ReparsePoint)
if ($reparsePoints.Count -ne 0) {
  throw "RuntimeRoot contains a reparse point: $($reparsePoints[0].FullName)"
}

$files = @(Get-ChildItem -LiteralPath $runtime -Recurse -Force -File | Sort-Object FullName)
if ($files.Count -eq 0) {
  throw "RuntimeRoot contains no files"
}

$archive = [System.IO.Path]::GetFullPath($OutputArchive)
$archiveParent = Split-Path -Parent $archive
New-Item -ItemType Directory -Force -Path $archiveParent | Out-Null
if ($archive.StartsWith("$runtime\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputArchive must be outside RuntimeRoot"
}
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open(
  $archive,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
try {
  $zip = [System.IO.Compression.ZipArchive]::new(
    $stream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $true
  )
  try {
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($runtime.Length).TrimStart("\", "/").Replace("\", "/")
      if (-not $relative -or $relative.Split("/") -contains "..") {
        throw "Unsafe runtime path: $($file.FullName)"
      }
      $entry = $zip.CreateEntry(
        "package/$relative",
        [System.IO.Compression.CompressionLevel]::Optimal
      )
      $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $input = [System.IO.File]::OpenRead($file.FullName)
      $output = $entry.Open()
      try {
        $input.CopyTo($output)
      } finally {
        $output.Dispose()
        $input.Dispose()
      }
    }
  } finally {
    $zip.Dispose()
  }
} finally {
  $stream.Dispose()
}

$archiveInfo = Get-Item -LiteralPath $archive
if ($archiveInfo.Length -gt 32MB) {
  Remove-Item -LiteralPath $archive -Force
  throw "TTS runtime archive exceeds the 32 MiB limit"
}

Write-Host "Packaged $($files.Count) unqualified candidate runtime files to $archive"
