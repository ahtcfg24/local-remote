# Windows PowerShell 5.1+ launcher. Task Scheduler supplies the logged-in
# user's interactive desktop; an SSH shell alone runs in Session 0.
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'doctor', 'uninstall', 'run')]
    [string]$Command = 'start',
    [string]$InteractiveUser = '',
    [switch]$InstallFirewall,
    [string]$FirewallRemoteAddress = 'LocalSubnet',
    [switch]$RunElevated,
    [switch]$RunLimited
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RootDir = $PSScriptRoot
$RunDir = Join-Path $RootDir '.run'
$LogFile = Join-Path $RunDir 'local-remote.log'
$ConfigFile = Join-Path $RunDir 'windows-service.json'
$ServiceTokenFile = Join-Path $RunDir 'windows-service-token'
$SupervisorFile = Join-Path $RunDir 'windows-supervisor.json'
$StopFile = Join-Path $RunDir 'windows-stop'
$AgentFile = Join-Path $RootDir '.build\local-remote-agent.exe'
$ServerFile = Join-Path $RootDir 'server.js'
$RuntimeCli = Join-Path $RootDir 'scripts\windows-runtime.mjs'
$ConfigKeys = @('HOST', 'PORT', 'FPS', 'QUALITY', 'MAX_WIDTH', 'MAX_CLIENTS')
$sha = [Security.Cryptography.SHA256]::Create()
try { $identity = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($RootDir.ToLowerInvariant()))).Replace('-', '').Substring(0, 12) }
finally { $sha.Dispose() }
$TaskName = "LocalRemote-$identity"
$FirewallName = "$TaskName-LAN"
Set-Location -LiteralPath $RootDir

function Write-Info([string]$Message) { Write-Host "[start] $Message" }

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Import-ProjectEnvironment {
    $envFile = Join-Path $RootDir '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return }
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        if ($line -match '^\s*(?:#.*)?$') { continue }
        if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            throw 'Invalid .env entry. Use NAME=value; PowerShell/shell commands are not supported.'
        }
        $key = $Matches[1]
        $value = $Matches[2]
        if ($key -notin ($ConfigKeys + @('REMOTE_TOKEN'))) { continue }
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        } else { $value = $value -replace '\s+#.*$', '' }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

function Find-Node {
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js 20+ is required. Install Node.js and open a new PowerShell window.' }
    $version = & $node.Source --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
        throw "Node.js 20+ is required (found $version)."
    }
    return $node.Source
}

function Get-Task { return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Resolve-RunElevated($Installed, $Task, [bool]$ElevatedRequested, [bool]$LimitedRequested) {
    if ($ElevatedRequested -and $LimitedRequested) { throw 'Use either -RunElevated or -RunLimited, not both.' }
    if ($ElevatedRequested) { return $true }
    if ($LimitedRequested) { return $false }
    if ($Installed -and $Installed.PSObject.Properties['runElevated']) { return [bool]$Installed.runElevated }
    # Older installations did not persist a run level. Preserve an existing
    # task's explicit choice; a first installation remains Limited.
    return [bool]($Task -and [string]$Task.Principal.RunLevel -eq 'Highest')
}

function Resolve-InteractiveUser {
    if ($InteractiveUser) { return $InteractiveUser }
    $installed = Read-Json $ConfigFile
    if ($installed -and $installed.interactiveUser) { return [string]$installed.interactiveUser }
    $desktopUser = (Get-CimInstance Win32_ComputerSystem).UserName
    if (-not $desktopUser) { throw 'Sign into the Windows desktop first, or specify -InteractiveUser DOMAIN\user. The service cannot capture a signed-out desktop.' }
    return $desktopUser
}

function Protect-Runtime([string]$User) {
    # Files created by Node inherit this Windows DACL. POSIX chmod alone does
    # not restrict Windows access. Administrators can still take ownership.
    New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
    $account = [Security.Principal.NTAccount]::new($User)
    $sid = $account.Translate([Security.Principal.SecurityIdentifier])
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($allowed in @($sid, $systemSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($allowed, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $RunDir -AclObject $acl
    foreach ($file in Get-ChildItem -LiteralPath $RunDir -File) {
        $fileAcl = Get-Acl -LiteralPath $file.FullName
        $fileAcl.SetAccessRuleProtection($false, $false)
        foreach ($rule in @($fileAcl.Access | Where-Object { -not $_.IsInherited })) { $fileAcl.RemoveAccessRuleSpecific($rule) }
        Set-Acl -LiteralPath $file.FullName -AclObject $fileAcl
    }
    $envFile = Join-Path $RootDir '.env'
    if (Test-Path -LiteralPath $envFile) {
        $envAcl = [Security.AccessControl.FileSecurity]::new()
        $envAcl.SetOwner($sid)
        $envAcl.SetAccessRuleProtection($true, $false)
        foreach ($allowed in @($sid, $systemSid)) {
            $envAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($allowed, 'FullControl', 'Allow'))
        }
        Set-Acl -LiteralPath $envFile -AclObject $envAcl
    }
}

function Prepare-Runtime([string]$User, [bool]$Elevated) {
    Protect-Runtime $User
    $node = Find-Node
    Import-ProjectEnvironment
    $normalized = & $node $RuntimeCli config
    if ($LASTEXITCODE -ne 0) { throw 'Configuration normalization failed.' }
    $config = $normalized | ConvertFrom-Json
    $values = [ordered]@{
        HOST = [string]$config.host; PORT = [string]$config.port; FPS = [string]$config.fps
        QUALITY = [string]$config.quality; MAX_WIDTH = [string]$config.maxWidth; MAX_CLIENTS = [string]$config.maxClients
    }
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
    if (-not $npm) { throw 'npm.cmd is required. Reinstall Node.js with npm included.' }
    $installedLock = Join-Path $RootDir 'node_modules\.package-lock.json'
    $needsInstall = -not (Test-Path -LiteralPath $installedLock)
    if (-not $needsInstall) {
        $stamp = (Get-Item -LiteralPath $installedLock).LastWriteTimeUtc
        $needsInstall = (Get-Item 'package-lock.json').LastWriteTimeUtc -gt $stamp -or (Get-Item 'package.json').LastWriteTimeUtc -gt $stamp
    }
    if ($needsInstall) {
        Write-Info 'Installing npm dependencies...'
        & $npm.Source ci --no-audit --no-fund | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    $effectiveToken = & $node $RuntimeCli token
    if ($LASTEXITCODE -ne 0 -or -not $effectiveToken) { throw 'Could not load the persistent access token.' }
    return [PSCustomObject]@{ version = 1; nodePath = $node; interactiveUser = $User; runElevated = $Elevated; environment = [PSCustomObject]$values; serviceToken = $effectiveToken.Trim() }
}

function Ensure-NativeBuilt {
    $buildNeeded = -not (Test-Path -LiteralPath $AgentFile)
    if (-not $buildNeeded) {
        $built = (Get-Item -LiteralPath $AgentFile).LastWriteTimeUtc
        $sources = @(Get-ChildItem (Join-Path $RootDir 'native\windows') -Recurse -File)
        $sources += Get-Item (Join-Path $RootDir 'scripts\build-native.ps1')
        $buildNeeded = @($sources | Where-Object { $_.LastWriteTimeUtc -gt $built }).Count -gt 0
    }
    if ($buildNeeded) {
        # A running Windows executable cannot be replaced. This is called
        # only after stopping the previous interactive service and worker.
        Write-Info 'Building Windows capture/input agent...'
        $npm = Get-Command npm.cmd -CommandType Application
        & $npm.Source run build:native | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $AgentFile)) { throw 'Windows native build failed.' }
    }
}

function Save-Runtime($Config) {
    Write-Utf8 $ServiceTokenFile ($Config.serviceToken + "`n")
    $runtime = [ordered]@{ version = $Config.version; nodePath = $Config.nodePath; interactiveUser = $Config.interactiveUser; runElevated = [bool]$Config.runElevated; environment = $Config.environment }
    Write-Utf8 $ConfigFile (($runtime | ConvertTo-Json -Depth 4) + "`n")
}

function Use-InstalledEnvironment($Config) {
    foreach ($key in $ConfigKeys) { [Environment]::SetEnvironmentVariable($key, [string]$Config.environment.$key, 'Process') }
    if (-not (Test-Path -LiteralPath $ServiceTokenFile)) { throw 'Service token missing. Run .\start.ps1 restart to repair the installation.' }
    $token = (Get-Content -LiteralPath $ServiceTokenFile -Raw -Encoding UTF8).Trim()
    if (-not $token) { throw 'Service token is empty. Check .run/windows-service-token.' }
    $env:REMOTE_TOKEN = $token
}

function Test-Health($Config, [switch]$Details) {
    Use-InstalledEnvironment $Config
    $arguments = @((Join-Path $RootDir 'scripts\service-health.mjs'))
    if ($Details) { $arguments += '--details' }
    & $Config.nodePath @arguments | ForEach-Object { Write-Host $_ }
    return $LASTEXITCODE -eq 0
}

function Show-AccessUrls($Config) {
    Use-InstalledEnvironment $Config
    & $Config.nodePath (Join-Path $RootDir 'scripts\access-urls.mjs')
}

function Test-Port($Config) {
    foreach ($key in $ConfigKeys) { [Environment]::SetEnvironmentVariable($key, [string]$Config.environment.$key, 'Process') }
    & $Config.nodePath $RuntimeCli port
    if ($LASTEXITCODE -ne 0) { throw 'The configured address/port is unavailable.' }
}

function Get-OwnedProcesses {
    $record = Read-Json $SupervisorFile
    if (-not $record) { return @() }
    $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if (-not $supervisor -or $supervisor.CreationDate.ToUniversalTime().ToString('o') -ne $record.created -or $supervisor.CommandLine -notlike "*$RootDir\start.ps1*") { return @() }
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($record.pid)" | Where-Object { $_.CommandLine -like "*$ServerFile*" })
    return @($supervisor) + $children
}

function Stop-ManagedService {
    $owned = @(Get-OwnedProcesses)
    if (Test-Path -LiteralPath $RunDir) { Write-Utf8 $StopFile "stop`n" }
    # Ask Node to close clients, release native held input, and close the
    # worker before terminating its task. Force is an unresponsive fallback.
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        $task = Get-Task
        $stillOwned = @(Get-OwnedProcesses)
        if ((-not $task -or $task.State -ne 'Running') -and $stillOwned.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
    }
    if (Get-Task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    foreach ($process in $owned) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction SilentlyContinue
        if ($current -and $current.CreationDate -eq $process.CreationDate) {
            # Kill only this exact owned process tree. Never kill by a port,
            # executable name, or an unverified stale PID.
            & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.ProcessId /T /F 2>&1 | Out-Null
        }
    }
    Remove-Item -LiteralPath $SupervisorFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
}

function Install-Task($Config) {
    $User = [string]$Config.interactiveUser
    $runLevel = 'Limited'
    if ($Config.runElevated) {
        Assert-Administrator 'Installing an elevated desktop task'
        $runLevel = 'Highest'
    }
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $scriptPath = Join-Path $RootDir 'start.ps1'
    # Windows filenames cannot contain double quotes. Keep the full path as
    # one -File argument; do not interpolate it into -Command or cmd.exe.
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" run" -WorkingDirectory $RootDir
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel $runLevel
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description "Local Remote interactive desktop service for $RootDir" -Force | Out-Null
}

function Assert-Administrator([string]$Action) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "$Action requires an elevated PowerShell window. The launcher does not request elevation automatically."
    }
}

function Install-LanFirewall($Config) {
    Assert-Administrator '-InstallFirewall'
    if ($FirewallRemoteAddress -match '^(Any|\*|0\.0\.0\.0/0|::/0)$') { throw 'FirewallRemoteAddress must be a trusted LAN subnet or LocalSubnet.' }
    $localAddress = if ($Config.environment.HOST -in @('0.0.0.0', '::')) { 'Any' } else { $Config.environment.HOST }
    # Only the one per-checkout rule is replaced; unrelated firewall rules
    # and the machine's network category remain untouched.
    $existing = Get-NetFirewallRule -Name $FirewallName -ErrorAction SilentlyContinue
    if ($existing) { Remove-NetFirewallRule -Name $FirewallName }
    New-NetFirewallRule -Name $FirewallName -DisplayName "Local Remote LAN ($($Config.interactiveUser))" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Config.environment.PORT -LocalAddress $localAddress -RemoteAddress $FirewallRemoteAddress -Program $Config.nodePath -Profile Private,Domain -EdgeTraversalPolicy Block | Out-Null
    Write-Info "Firewall installed: TCP $($Config.environment.PORT), $localAddress, peers $FirewallRemoteAddress, Private/Domain only."
}

function Start-ManagedService([switch]$Restart) {
    if ($InstallFirewall) { Assert-Administrator '-InstallFirewall' }
    $installed = Read-Json $ConfigFile
    $task = Get-Task
    $elevated = Resolve-RunElevated $installed $task ([bool]$RunElevated) ([bool]$RunLimited)
    $installedElevated = Resolve-RunElevated $installed $task $false $false
    $taskElevated = [bool]($task -and [string]$task.Principal.RunLevel -eq 'Highest')
    $modeChanged = $elevated -ne $installedElevated -or ($task -and $elevated -ne $taskElevated)
    if (-not $Restart -and -not $modeChanged -and $installed -and $task -and $task.State -eq 'Running' -and (Test-Health $installed)) {
        if ($InstallFirewall) { Install-LanFirewall $installed }
        Write-Info 'Service is already healthy. Use restart to apply code or configuration changes.'
        Show-AccessUrls $installed
        $null = Test-Health $installed -Details
        return
    }
    if ($elevated -or $taskElevated) { Assert-Administrator 'Installing or changing an elevated desktop task' }
    $user = Resolve-InteractiveUser
    $config = Prepare-Runtime $user $elevated
    if ($installed -and $task -and $task.State -eq 'Running' -and ($config.environment.PORT -ne $installed.environment.PORT -or $config.environment.HOST -ne $installed.environment.HOST)) {
        # Keep a working old instance when a newly requested endpoint is busy.
        Test-Port $config
    }
    Stop-ManagedService
    Test-Port $config
    try { Ensure-NativeBuilt } catch {
        if ($installed -and $task -and (Test-Path -LiteralPath $AgentFile)) {
            Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Write-Info 'Native build failed; attempted to restart the previous installed task.'
        }
        throw
    }
    Save-Runtime $config
    Install-Task $config
    if ($InstallFirewall) { Install-LanFirewall $config }
    Start-ScheduledTask -TaskName $TaskName
    $installedTask = Get-Task
    Write-Info "Started scheduled task $TaskName as $user (interactive desktop, $($installedTask.Principal.RunLevel))."
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (Test-Health $config) {
            Write-Info 'HTTP, authentication, and native agent are ready.'
            Show-AccessUrls $config
            $null = Test-Health $config -Details
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Service did not become ready. Ensure the task user is signed into the desktop, then run .\start.ps1 doctor and .\start.ps1 logs.'
}

function Invoke-Runner {
    $config = Read-Json $ConfigFile
    if (-not $config) { throw 'Service configuration missing; run .\start.ps1 first.' }
    if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        throw 'Desktop capture must run in a logged-in interactive session. Use .\start.ps1 start; do not run server.js or the run command directly through SSH.'
    }
    Use-InstalledEnvironment $config
    $env:LOCAL_REMOTE_STOP_FILE = $StopFile
    if (Test-Path -LiteralPath $StopFile) { return }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    Write-Utf8 $SupervisorFile ((@{ pid = $PID; created = $current.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json) + "`n")
    $attempt = 0
    while (-not (Test-Path -LiteralPath $StopFile)) {
        $started = Get-Date
        "[supervisor] $(Get-Date -Format o) Starting Node in interactive session $([Diagnostics.Process]::GetCurrentProcess().SessionId)." | Out-File -LiteralPath $LogFile -Append -Encoding UTF8
        # Windows PowerShell converts native stderr into ErrorRecords. Keep
        # normal diagnostic stderr from terminating the supervisor pipeline.
        $ErrorActionPreference = 'Continue'
        & $config.nodePath $ServerFile 2>&1 | ForEach-Object {
            # NativeCommandError formatting can truncate long stderr lines.
            # Extract the original message before Out-File formats objects.
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message }
            else { [string]$_ }
        } | Out-File -LiteralPath $LogFile -Append -Encoding UTF8 -Width 32767
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if (Test-Path -LiteralPath $StopFile) { break }
        if (((Get-Date) - $started).TotalSeconds -ge 60) { $attempt = 0 }
        $delay = [Math]::Min(30, [Math]::Pow(2, [Math]::Min($attempt, 5)))
        $attempt++
        "[supervisor] $(Get-Date -Format o) Node exited ($exitCode); restart in ${delay}s." | Out-File -LiteralPath $LogFile -Append -Encoding UTF8
        Start-Sleep -Seconds $delay
    }
}

function Show-Doctor {
    $failed = $false
    Write-Info "Windows $([Environment]::OSVersion.Version); launcher session $([Diagnostics.Process]::GetCurrentProcess().SessionId)."
    try { Write-Info "Node: $(Find-Node)" } catch { Write-Host "[fail] $($_.Exception.Message)"; $failed = $true }
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
    if ($npm) { Write-Info "npm: $($npm.Source)" } else { Write-Host '[fail] npm.cmd is missing.'; $failed = $true }
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
    if (Test-Path -LiteralPath $compiler) { Write-Info "C# compiler: $compiler" } else { Write-Host '[fail] .NET Framework 4.x C# compiler is missing.'; $failed = $true }
    if (Test-Path -LiteralPath $AgentFile) { Write-Info "Native agent: $AgentFile" } else { Write-Info 'Native agent is not built; start will build it.' }
    $task = Get-Task
    $config = Read-Json $ConfigFile
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Info "Task: $TaskName, state $($task.State), user $($task.Principal.UserId), logon $($task.Principal.LogonType), run level $($task.Principal.RunLevel), result $($info.LastTaskResult)."
    } else { Write-Info 'Scheduled task has not been installed.' }
    $desktopUser = (Get-CimInstance Win32_ComputerSystem).UserName
    Write-Info "Desktop user: $desktopUser"
    if (-not $desktopUser) { Write-Host '[fail] No desktop user is signed in.'; $failed = $true }
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object {
        Write-Info "IPv4: $($_.IPAddress)/$($_.PrefixLength), $($_.InterfaceAlias), origin $($_.PrefixOrigin)."
    }
    $firewall = Get-NetFirewallRule -Name $FirewallName -ErrorAction SilentlyContinue
    if ($firewall) {
        $address = $firewall | Get-NetFirewallAddressFilter
        $port = $firewall | Get-NetFirewallPortFilter
        $application = $firewall | Get-NetFirewallApplicationFilter
        Write-Info "Firewall: $($firewall.Enabled), profiles $($firewall.Profile), TCP $($port.LocalPort), local $($address.LocalAddress), remote $($address.RemoteAddress)."
        Write-Info "Firewall program: $($application.Program)"
    } else { Write-Info 'No Local Remote firewall rule; use start -InstallFirewall in elevated PowerShell for LAN access.' }
    Write-Info "Token saved: $(Test-Path -LiteralPath $ServiceTokenFile). Log: $LogFile"
    if ($config -and $task -and $task.State -eq 'Running') {
        if (-not (Test-Health $config -Details)) { $failed = $true }
    }
    if ($failed) { throw 'Doctor found a problem; see the checks above.' }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'start.ps1 requires Windows. On macOS use ./start.sh.' }
    if (($RunElevated -or $RunLimited) -and $Command -notin @('start', 'restart')) { throw '-RunElevated and -RunLimited apply only to start or restart.' }
    if ($RunElevated -and $RunLimited) { throw 'Use either -RunElevated or -RunLimited, not both.' }
    switch ($Command) {
        'start' { Start-ManagedService }
        'restart' { Start-ManagedService -Restart }
        'stop' { Stop-ManagedService; Write-Info 'Stopped; login startup and token remain installed.' }
        'status' {
            $task = Get-Task
            $config = Read-Json $ConfigFile
            if (-not $task -or -not $config) { throw 'Service is not installed. Run .\start.ps1 first.' }
            Write-Info "Task ${TaskName}: $($task.State), user $($task.Principal.UserId), run level $($task.Principal.RunLevel)."
            if ($task.State -ne 'Running' -or -not (Test-Health $config -Details)) { throw 'Service is not healthy. Run .\start.ps1 doctor.' }
            Show-AccessUrls $config
        }
        'logs' {
            if (-not (Test-Path -LiteralPath $LogFile)) { throw 'Log not created yet. Start the service first.' }
            Get-Content -LiteralPath $LogFile -Tail 80 -Wait -Encoding UTF8
        }
        'doctor' { Show-Doctor }
        'uninstall' {
            $firewall = Get-NetFirewallRule -Name $FirewallName -ErrorAction SilentlyContinue
            if ($firewall) { Assert-Administrator 'Removing the LAN firewall rule' }
            Stop-ManagedService
            if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
            if ($firewall) { Remove-NetFirewallRule -Name $FirewallName }
            Write-Info 'Removed scheduled task and its LAN firewall rule; token, configuration, and logs remain in .run.'
        }
        'run' { Invoke-Runner }
    }
} catch {
    Write-Host "[fail] $($_.Exception.Message)"
    exit 1
}
