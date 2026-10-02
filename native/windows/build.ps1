param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$build = Join-Path $root '.build'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $compiler)) { throw 'The Windows .NET Framework C# compiler is unavailable. Enable .NET Framework 4.x before building.' }
$stage = Join-Path $build ('.windows-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  & $compiler /nologo /optimize+ /target:exe /platform:anycpu /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/out:$stage\local-remote-agent.exe" "$PSScriptRoot\Agent.cs"
  if ($LASTEXITCODE -ne 0) { throw "Windows agent compilation failed ($LASTEXITCODE)." }
  & $compiler /nologo /optimize+ /target:winexe /platform:anycpu /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/out:$stage\local-remote-test-window.exe" "$PSScriptRoot\TestWindow.cs"
  if ($LASTEXITCODE -ne 0) { throw "Windows test window compilation failed ($LASTEXITCODE)." }
  & "$stage\local-remote-agent.exe" --self-test
  if ($LASTEXITCODE -ne 0) { throw "Windows agent self-tests failed ($LASTEXITCODE)." }
  Move-Item -Force "$stage\local-remote-agent.exe" "$build\local-remote-agent.exe"
  Move-Item -Force "$stage\local-remote-test-window.exe" "$build\local-remote-test-window.exe"
  Write-Host "Built $build\local-remote-agent.exe"
  Write-Host "Built $build\local-remote-test-window.exe"
} finally { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
