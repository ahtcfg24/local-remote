# Read-only launcher policy tests. Task Scheduler commands are mocked; this
# script never registers a task, changes its privileges, or starts a service.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RootDir = Split-Path $PSScriptRoot -Parent
$TaskName = 'LocalRemote-LauncherPolicyTest'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $RootDir 'start.ps1'), [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Resolve-RunElevated', 'Install-Task')) {
    $functionAst = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object { $_.Name -eq $name }
    if (-not $functionAst) { throw "Missing launcher function $name." }
    . ([scriptblock]::Create($functionAst.Extent.Text))
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) { throw "$Message (expected $Expected, found $Actual)." }
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    if (-not $threw) { throw $Message }
}
function New-TestTask([string]$Level) { return [PSCustomObject]@{ Principal = [PSCustomObject]@{ RunLevel = $Level } } }

$savedLimited = [PSCustomObject]@{ runElevated = $false }
$savedHighest = [PSCustomObject]@{ runElevated = $true }
$legacy = [PSCustomObject]@{ version = 1 }
$limitedTask = New-TestTask 'Limited'
$highestTask = New-TestTask 'Highest'
Assert-Equal $false (Resolve-RunElevated $null $null $false $false) 'First install must remain Limited'
Assert-Equal $false (Resolve-RunElevated $legacy $limitedTask $false $false) 'Legacy Limited task must stay Limited'
Assert-Equal $true (Resolve-RunElevated $legacy $highestTask $false $false) 'Legacy explicit Highest preference must survive'
Assert-Equal $true (Resolve-RunElevated $savedHighest $highestTask $false $false) 'Ordinary restart must preserve Highest preference'
Assert-Equal $false (Resolve-RunElevated $savedLimited $highestTask $false $false) 'Stored Limited preference must remain authoritative'
Assert-Equal $false (Resolve-RunElevated $savedHighest $highestTask $false $true) 'Explicit RunLimited must override saved Highest'
Assert-Equal $true (Resolve-RunElevated $savedLimited $limitedTask $true $false) 'Explicit RunElevated must select Highest'
Assert-Throws { Resolve-RunElevated $savedLimited $limitedTask $true $true } 'Conflicting privilege switches must fail'

# Mock every scheduler mutation so guard ordering can be verified safely.
$script:Events = [Collections.Generic.List[string]]::new()
$script:IsAdmin = $false
$script:Principal = $null
function Assert-Administrator([string]$Action) {
    $script:Events.Add('admin-check')
    if (-not $script:IsAdmin) { throw "$Action requires administrator privileges." }
}
function New-ScheduledTaskAction([string]$Execute, [string]$Argument, [string]$WorkingDirectory) {
    $script:Events.Add('action')
    return [PSCustomObject]@{ Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskPrincipal([string]$UserId, [string]$LogonType, [string]$RunLevel) {
    $script:Events.Add('principal')
    $script:Principal = [PSCustomObject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
    return $script:Principal
}
function New-ScheduledTaskTrigger([switch]$AtLogOn, [string]$User) {
    $script:Events.Add('trigger')
    return [PSCustomObject]@{ User = $User }
}
function New-ScheduledTaskSettingsSet([string]$MultipleInstances, [TimeSpan]$ExecutionTimeLimit, [int]$RestartCount, [TimeSpan]$RestartInterval, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable) {
    $script:Events.Add('settings')
    return [PSCustomObject]@{ RestartCount = $RestartCount }
}
function Register-ScheduledTask([string]$TaskName, $Action, $Principal, $Trigger, $Settings, [string]$Description, [switch]$Force) {
    $script:Events.Add('register')
}

Install-Task ([PSCustomObject]@{ interactiveUser = 'TEST\user'; runElevated = $false })
Assert-Equal 'Limited' $script:Principal.RunLevel 'Default task principal must use Limited'
Assert-Equal 'Interactive' $script:Principal.LogonType 'Task must retain the interactive desktop identity'
Assert-Equal $false ($script:Events.Contains('admin-check')) 'Limited installation must not request elevation'

$script:Events.Clear()
Assert-Throws { Install-Task ([PSCustomObject]@{ interactiveUser = 'TEST\user'; runElevated = $true }) } 'Highest installation must reject a non-admin caller'
Assert-Equal 1 $script:Events.Count 'Rejected elevation must perform no scheduler mutation'
Assert-Equal 'admin-check' $script:Events[0] 'Admin identity must be checked before constructing/registering the task'

$script:Events.Clear()
$script:IsAdmin = $true
Install-Task ([PSCustomObject]@{ interactiveUser = 'TEST\user'; runElevated = $true })
Assert-Equal 'Highest' $script:Principal.RunLevel 'Explicit elevated preference must select Highest'
Assert-Equal 'Interactive' $script:Principal.LogonType 'Elevated task must retain Interactive logon'
Assert-Equal 'admin-check' $script:Events[0] 'Even an admin caller must be checked before task changes'
Assert-Equal $true ($script:Events.Contains('register')) 'Authorized elevated installation must register the task'
Write-Host 'Windows launcher policy passed: default/persisted/explicit modes, conflicting flags, Interactive identity, and pre-mutation admin guard. Scheduler commands were mocked.'
