# Independent session-lifetime cleanup owner. Private stdin is its ONLY authority
# channel; backgroundJobs has no writable stdin, so the existing sentinel remains
# only the unload/session-end signal. Watchdog generations never own this process.
param([int] $LifetimePid, [string] $LifetimeStarted)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
. "$PSScriptRoot/launch.ps1"
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false, 4096, $true)
$sentinel = $null
$jobs = @{}
$offers = @{}
$session = $null
$incomplete = $false
try {
    $bootstrap = $reader.ReadLine() | ConvertFrom-Json
    if ($bootstrap.event -cne 'custody-session' -or [string]$bootstrap.session -cnotmatch '^[0-9a-f-]{36}$') {
        throw 'Invalid custody session.'
    }
    $session = [string]$bootstrap.session
    $sentinel = [Diagnostics.Process]::GetProcessById($LifetimePid)
    if ($sentinel.HasExited -or [OwnedUia.LaunchGuard]::CreationTime($sentinel.Handle).ToString() -cne $LifetimeStarted) {
        throw 'Custody lifetime identity changed.'
    }
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try {
        [Console]::WriteLine((@{ event = 'custody-ready'; session = $session; pid = $PID;
            started = [OwnedUia.LaunchGuard]::CreationTime($self.Handle).ToString() } | ConvertTo-Json -Compress))
    } finally { $self.Dispose() }
    $inputLine = $reader.ReadLineAsync()
    $endingSince = $null
    while ($true) {
        if ($sentinel.WaitForExit(0) -and $null -eq $endingSince) { $endingSince = [DateTime]::UtcNow }
        if ($inputLine.IsCompleted) {
            $line = $inputLine.GetAwaiter().GetResult()
            if ($null -eq $line) {
                if ($null -eq $endingSince) { $endingSince = [DateTime]::UtcNow }
            } else {
                $message = $null
                try {
                    $message = $line | ConvertFrom-Json
                    if ($message.event -ceq 'end' -and $session -ceq [string]$message.session) {
                        if ($null -eq $endingSince) { $endingSince = [DateTime]::UtcNow }
                        $inputLine = $reader.ReadLineAsync()
                        continue
                    }
                    if ($null -eq $endingSince -and $session -ceq [string]$message.session -and
                        $message.event -cin @('root', 'stop') -and
                        [string]$message.request -cmatch '^[0-9a-f-]{36}$') {
                        if ($message.event -ceq 'root') {
                            $token = [string]$message.transfer
                            if (-not $jobs.ContainsKey($token) -or $jobs[$token].Name -cne [string]$message.job -or
                                [int]$message.pid -le 0 -or [long]$message.started -le 0) { throw 'Invalid custody root.' }
                            $jobs[$token].RememberRoot([int]$message.pid, [long]$message.started)
                            $message.event = 'root-recorded'
                        } else {
                            $stopIncomplete = $false
                            foreach ($job in @($jobs.Values)) {
                                # All generations use the SAME own-window checks and root/grace metadata.
                                # Rootless jobs remain pending while either original producer lives;
                                # abandoned ones use the cached exact producer handles, not PID recovery.
                                # Never terminate a whole job or retire producers for emergency stop.
                                try { $job.StopHeadless() }
                                catch { $stopIncomplete = $true }
                            }
                            $message | Add-Member -NotePropertyName incomplete -NotePropertyValue $stopIncomplete
                            $message.event = 'stopped'
                        }
                        [Console]::WriteLine(($message | ConvertTo-Json -Compress))
                        $inputLine = $reader.ReadLineAsync()
                        continue
                    }
                    if ($null -ne $endingSince -or $message.event -cne 'retain' -or
                        $session -cne [string]$message.session -or
                        [string]$message.job -cnotmatch '^amira-uia-job-[0-9a-f-]{36}$' -or
                        [string]$message.transfer -cnotmatch '^[0-9a-f-]{36}$' -or
                        [int]$message.pid -le 0 -or [long]$message.started -le 0 -or [long]$message.handle -le 0 -or
                        [int]$message.writerPid -le 0 -or [long]$message.writerStarted -le 0) { throw 'Invalid custody transfer.' }
                    $token = [string]$message.transfer
                    # Exact, idempotent binding. Replayed or changed numeric handles can
                    # never cause a second pull after the source slot was released.
                    $binding = (@($message.session, $message.job, $message.pid, $message.started, $message.handle,
                        $message.writerPid, $message.writerStarted) | ConvertTo-Json -Compress)
                    if ($offers.ContainsKey($token)) {
                        if ($offers[$token] -cne $binding) { throw 'Mismatched custody transfer.' }
                    } else {
                        $job = [OwnedUia.LaunchGuard]::RetainForCleanup([string]$message.job,
                            [int]$message.pid, [long]$message.started, [long]$message.handle,
                            [int]$message.writerPid, [long]$message.writerStarted)
                        $jobs[$token] = $job
                        $offers[$token] = $binding
                    }
                    $message.event = 'retained'
                    [Console]::WriteLine(($message | ConvertTo-Json -Compress))
                } catch {
                    [Console]::Error.WriteLine('UIA custody transfer rejected; launch refused.')
                    if ($null -ne $message) {
                        if ($null -ne $message.PSObject.Properties['request']) { $message.event = 'command-error' }
                        else { $message.event = 'custody-error' }
                        [Console]::WriteLine(($message | ConvertTo-Json -Compress))
                    }
                }
                $inputLine = $reader.ReadLineAsync()
            }
        }
        if ($null -ne $endingSince -and ([DateTime]::UtcNow - $endingSince).TotalMilliseconds -ge 3000) { break }
        Start-Sleep -Milliseconds 25
    }
} catch {
    $incomplete = $true
    [Console]::Error.WriteLine('UIA custody owner failed; desktop control must stop.')
} finally {
    # All authenticated launch producers must be gone BEFORE job drains. Otherwise
    # a suspended/in-flight creation could enter a job after an empty-members check.
    $reported = $false
    while ($true) {
        $failed = $false
        foreach ($job in @($jobs.Values)) {
            try { $job.RetireProducers() }
            catch { $failed = $true }
        }
        foreach ($job in @($jobs.Values)) {
            try { $job.Terminate() }
            catch { $failed = $true }
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $remaining = $false
            foreach ($job in @($jobs.Values)) {
                try { if ($job.Members().Length -gt 0) { $remaining = $true } }
                catch { $remaining = $true }
            }
            if (-not $remaining) { break }
            Start-Sleep -Milliseconds 25
        } while ($clock.ElapsedMilliseconds -lt 2000)
        if (-not $failed -and -not $remaining) { break }
        # Never abandon the last duplicates on an unconfirmed producer/drain.
        # The client may time out, but keeps this private owner alive to retry.
        if (-not $reported) {
            [Console]::Error.WriteLine('UIA custody cleanup incomplete; retained authority is retrying.')
            $reported = $true
        }
        Start-Sleep -Milliseconds 250
    }
    foreach ($job in @($jobs.Values)) { $job.Dispose() }
    if ($null -ne $sentinel) { $sentinel.Dispose() }
    if ($null -ne $session) {
        [Console]::WriteLine((@{ event = 'custody-drained'; session = $session; incomplete = $incomplete } | ConvertTo-Json -Compress))
    }
    if ($incomplete) { [Console]::Error.WriteLine('UIA custody cleanup incomplete.'); exit 1 }
}
