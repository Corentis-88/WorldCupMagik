$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ScriptPath = Join-Path $ProjectRoot "scripts\run-worldcupmagic.ps1"
$TaskName = "WorldCupMagic Daily Snapshot"

schtasks /Create /TN $TaskName /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" /SC DAILY /ST 09:00 /SD 06/04/2026 /F

Write-Host "Scheduled $TaskName to run daily at 09:00 from 2026-06-04."
