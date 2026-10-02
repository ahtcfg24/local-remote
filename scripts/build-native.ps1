param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'native\windows\build.ps1') -SelfTest:$SelfTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
