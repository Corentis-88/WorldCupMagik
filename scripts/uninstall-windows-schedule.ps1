$ErrorActionPreference = "Stop"

$TaskName = "WorldCupMagic Daily Snapshot"
schtasks /Delete /TN $TaskName /F
Write-Host "Removed $TaskName."
