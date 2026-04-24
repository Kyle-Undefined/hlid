#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Registers a Windows Task Scheduler task that starts Hlid at logon via WSL.

.DESCRIPTION
    Run this once from an elevated PowerShell prompt.
    The task runs hlid-start.sh inside Ubuntu-24.04 whenever you log in.
    Re-run to update the task if settings change.

.EXAMPLE
    .\Register-HlidTask.ps1
    .\Register-HlidTask.ps1 -WslDistro "Ubuntu" -RepoPath "/home/yourname/development/repos/hlid"
#>

param(
    [string]$TaskName  = "Hlid",
    [string]$WslDistro = "Ubuntu-24.04",
    [string]$RepoPath  = "/home/kyle/development/repos/hlid"
)

$ScriptPath = "$RepoPath/scripts/hlid-start.sh"
$WslExe     = "$env:SystemRoot\System32\wsl.exe"

# ── action ──────────────────────────────────────────────────────────────────
$Action = New-ScheduledTaskAction `
    -Execute $WslExe `
    -Argument "-d $WslDistro -- bash $ScriptPath"

# ── trigger: at logon for the current user ──────────────────────────────────
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# ── settings ────────────────────────────────────────────────────────────────
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit        (New-TimeSpan -Days 365) `
    -RestartCount              5                        `
    -RestartInterval           (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable                                 `
    -RunOnlyIfNetworkAvailable:$false

# ── principal: run as current user, only when logged on ─────────────────────
$Principal = New-ScheduledTaskPrincipal `
    -UserId    "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive                     `
    -RunLevel  Highest

# ── register ────────────────────────────────────────────────────────────────
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Write-Host "Updating existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName  $TaskName  `
    -Action    $Action    `
    -Trigger   $Trigger   `
    -Settings  $Settings  `
    -Principal $Principal `
    -Description "Starts the Hlid vault command center (UI + WebSocket server) via WSL at logon."

Write-Host ""
Write-Host "Task '$TaskName' registered. It will start automatically at next logon."
Write-Host "To start it now without logging out:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
