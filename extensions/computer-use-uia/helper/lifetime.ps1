# Headless session owner. Helper death/restart never means session end.
# This watchdog holds every authenticated launch job before the child may execute.
param(
    [switch] $Sentinel,
    [string] $StatePath,
    [int] $LifetimePid = 0,
    [string] $LifetimeStarted,
    [int] $RetirePid = 0,
    [string] $RetireStarted
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

. "$PSScriptRoot/launch.ps1"

function Get-ExactProcess($identity) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$identity.Pid)
        $null = $process.Handle
        if (-not $process.HasExited -and
            [OwnedUia.LaunchGuard]::CreationTime($process.Handle).ToString() -eq [string]$identity.Started) {
            return $process
        }
    } catch { }
    if ($null -ne $process) { $process.Dispose() }
    return $null
}

function Test-IdentityGone($identity) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$identity.Pid)
        $null = $process.Handle
        return ($process.HasExited -or [OwnedUia.LaunchGuard]::CreationTime($process.Handle) -ne [long]$identity.Started)
    } catch [ArgumentException] { return $true }
    catch { return $false }
    finally { if ($null -ne $process) { $process.Dispose() } }
}

function Stop-HelperIdentity($identity) {
    $helper = Get-ExactProcess $identity
    if ($null -ne $helper) {
        try {
            $helper.Kill() # Exact cached handle only, never a process-tree kill.
            if (-not $helper.WaitForExit(1000)) { throw 'Helper is still running.' }
        } catch {
            if (-not (Test-IdentityGone $identity)) { throw 'Helper identity cannot be confirmed exited.' }
        } finally { $helper.Dispose() }
    }
    if (-not (Test-IdentityGone $identity)) { throw 'Helper identity cannot be confirmed exited.' }
}

# Headless fallback when the owning watchdog died. This cannot adopt or kill apps.
if ($RetirePid -gt 0) {
    try { Stop-HelperIdentity @{ Pid = $RetirePid; Started = $RetireStarted }; exit 0 }
    catch { [Console]::Error.WriteLine('Exact helper retirement failed.'); exit 1 }
}

if ($Sentinel) {
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $identity = @{ Pid = $PID; Started = [OwnedUia.LaunchGuard]::CreationTime($self.Handle).ToString() }
        [Console]::WriteLine('UIA lifetime ready ' + ($identity | ConvertTo-Json -Compress))
    } finally { $self.Dispose() }
    while ($true) { Start-Sleep -Seconds 60 }
}

$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false, 4096, $true)
. "$PSScriptRoot/journal.ps1"
$script:journalKey = Read-JournalKey $reader
$lifetime = @{ Pid = $LifetimePid; Started = $LifetimeStarted }
$verified = Get-ExactProcess $lifetime
if ($null -eq $verified) { exit 1 }
$sentinelProcess = $verified
$jobs = @{}
$completedJobs = @{}
$cleanupIncomplete = $false
$endingSince = $null
$stopRequested = $false
# Writer provenance comes from the client's private pipe, not a replayable journal.
$script:writerIdentity = $null
$expectedHelperPid = 0
$helperGeneration = 0
$writerAccepted = $false
[Console]::WriteLine('UIA watchdog ready')
$inputLine = $reader.ReadLineAsync()

function Assert-KnownJobs($state) {
    foreach ($name in $state.Jobs) {
        # Never reopen an object by a journal-supplied name/handle. An unavailable
        # owner means incomplete cleanup, not permission to guess a kernel object.
        if (-not $jobs.ContainsKey($name) -and -not $completedJobs.ContainsKey($name)) {
            throw 'Launch job owner unavailable; journal retained.'
        }
    }
}

function Assert-CurrentWriter($state) {
    if ($null -eq $script:writerIdentity -or
        $state.Helper.Pid -ne $script:writerIdentity.Pid -or
        $state.Helper.Started -cne $script:writerIdentity.Started) {
        throw 'Stale launch journal; cleanup refused; journal retained.'
    }
}

function Remove-LaunchJob([string] $name) {
    if (-not $jobs.ContainsKey($name)) { return }
    $job = $jobs[$name]
    # Failed/rootless launches can contain suspended processes. Drain before dropping authority.
    $job.Terminate()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($job.Members().Length -gt 0) {
        if ($clock.ElapsedMilliseconds -ge 2000) { throw 'Failed launch job cleanup incomplete.' }
        Start-Sleep -Milliseconds 25
    }
    $job.Dispose()
    $jobs.Remove($name)
    $completedJobs[$name] = $true
}

function Remove-RootlessJobs {
    $failed = $false
    foreach ($name in @($jobs.Keys)) {
        if (-not $jobs[$name].HasRoot) {
            try { Remove-LaunchJob $name }
            catch { $failed = $true; [Console]::Error.WriteLine($_.Exception.Message) }
        }
    }
    if ($failed) { throw 'Rootless launch job cleanup incomplete.' }
}

function Stop-CurrentWriter {
    # This identity came over the private client pipe, never from a journal. Explicit
    # stop/session end may always retire our own helper, even if its journal is missing
    # or corrupted. Retained kernel jobs, not the journal, authorize their own cleanup.
    if ($null -eq $script:writerIdentity) { return }
    Stop-HelperIdentity $script:writerIdentity
    Remove-RootlessJobs
}

function Stop-RetainedJobs([bool] $force, $state) {
    if (-not $force) {
        $failed = $false
        foreach ($job in @($jobs.Values)) {
            try { $job.StopHeadless() }
            catch { $failed = $true; [Console]::Error.WriteLine('Launch job cleanup incomplete; continuing other jobs.') }
        }
        if ($failed) { throw 'Launch job cleanup is incomplete.' }
        return
    }
    # TerminateJobObject is asynchronous. Drain ALL jobs together, then retry once;
    # never let a bad journal or one failed job prevent visiting the remaining jobs.
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        foreach ($job in @($jobs.Values)) {
            try { $job.Terminate() }
            catch { [Console]::Error.WriteLine('Launch job termination failed; checking members and retrying.') }
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $complete = $true
            foreach ($job in @($jobs.Values)) {
                try { if ($job.Members().Length -gt 0) { $complete = $false } }
                catch { $complete = $false }
            }
            if ($null -ne $state) {
                foreach ($identity in $state.Processes) {
                    if (-not (Test-IdentityGone $identity)) { $complete = $false }
                }
            }
            if ($complete) { return }
            Start-Sleep -Milliseconds 25
        } while ($clock.ElapsedMilliseconds -lt 2000)
    }
    throw 'Launch job cleanup is incomplete.'
}

try {
    while ($true) {
        try { $ending = $sentinelProcess.WaitForExit(0) }
        catch { $ending = $true }
        if ($inputLine.IsCompleted) {
            $line = $inputLine.GetAwaiter().GetResult()
            if ($null -eq $line) { $ending = $true }
            else {
                try {
                    $message = $line | ConvertFrom-Json
                    if ($message.event -ceq 'helper-spawned') {
                        if ([int]$message.pid -le 0 -or [int]$message.generation -le $helperGeneration) { throw 'Invalid helper generation.' }
                        $expectedHelperPid = [int]$message.pid
                        $helperGeneration = [int]$message.generation
                        $writerAccepted = $false
                    } elseif ($message.event -ceq 'writer') {
                        if ($writerAccepted -or [int]$message.pid -ne $expectedHelperPid -or
                            [int]$message.generation -ne $helperGeneration) { throw 'Invalid helper writer event.' }
                        $identity = @{ Pid = [int]$message.pid; Started = [string]$message.started }
                        $verified = Get-ExactProcess $identity
                        if ($null -eq $verified) { throw 'Current helper identity changed; launch refused.' }
                        $verified.Dispose()
                        $script:writerIdentity = $identity
                        $writerAccepted = $true
                        [Console]::WriteLine((@{ event = 'writer-accepted'; pid = $identity.Pid; started = $identity.Started; generation = $helperGeneration } | ConvertTo-Json -Compress))
                    } elseif ($message.event -ceq 'retire') {
                        if ([int]$message.pid -ne $expectedHelperPid -or
                            [int]$message.generation -ne $helperGeneration) { throw 'Invalid helper retirement event.' }
                        $failed = $false
                        try {
                            Stop-HelperIdentity @{ Pid = [int]$message.pid; Started = [string]$message.started }
                            Remove-RootlessJobs
                        }
                        catch { $failed = $true; [Console]::Error.WriteLine($_.Exception.Message) }
                        [Console]::WriteLine((@{ event = 'retired'; pid = [int]$message.pid; started = [string]$message.started;
                            generation = [int]$message.generation; failed = $failed } | ConvertTo-Json -Compress))
                    } elseif ($message.event -ceq 'launch-finished') {
                        if (-not $writerAccepted -or [int]$message.generation -ne $helperGeneration -or
                            $message.failed -isnot [bool]) { throw 'Invalid launch completion event.' }
                        if ($jobs.ContainsKey([string]$message.job) -and
                            -not $jobs[$message.job].HasRoot) {
                            Remove-LaunchJob $message.job
                        }
                    } elseif ($message.event -ceq 'launch-root') {
                        if (-not $writerAccepted -or [int]$message.generation -ne $helperGeneration -or
                            -not $jobs.ContainsKey([string]$message.job)) { throw 'Invalid launch root request.' }
                        $jobs[$message.job].SetRoot([int]$message.pid, [long]$message.started, [uint32]$message.threadId)
                        [Console]::WriteLine((@{ event = 'root-registered'; job = $message.job } | ConvertTo-Json -Compress))
                    } elseif ($message.event -ceq 'create-job') {
                        if (-not $writerAccepted) { throw 'Current helper writer is unavailable; launch refused.' }
                        # Fresh jobs are bound to our accepted private writer, not file
                        # records. Unknown journal job names can never block or authorize creation.
                        if ($message.job -isnot [string] -or $message.job -cnotmatch '^amira-uia-job-[0-9a-f-]{36}$' -or
                            ($jobs.ContainsKey($message.job) -or $completedJobs.ContainsKey($message.job))) { throw 'Invalid launch job request.' }
                        $job = [OwnedUia.LaunchGuard]::CreateFor($message.job, [int]$script:writerIdentity.Pid, [long]$script:writerIdentity.Started)
                        $jobs[$message.job] = $job
                        [Console]::WriteLine((@{ event = 'job-created'; job = $message.job; handle = $job.HelperHandle;
                            parentHandle = $job.ParentHandle; parentPid = $job.ParentPid; parentStarted = $job.ParentStarted.ToString() } | ConvertTo-Json -Compress))
                    } elseif ($message.event -ceq 'stop') { $stopRequested = $true }
                } catch { [Console]::Error.WriteLine($_.Exception.Message) }
                $inputLine = $reader.ReadLineAsync()
            }
        }
        if ($ending -and $null -eq $endingSince) { $endingSince = [DateTime]::UtcNow }
        $force = $null -ne $endingSince -and ([DateTime]::UtcNow - $endingSince).TotalMilliseconds -ge 3000
        if ($stopRequested -or $force) {
            $cleanupIncomplete = $false
            try { Stop-CurrentWriter }
            catch { $cleanupIncomplete = $true; [Console]::Error.WriteLine($_.Exception.Message) }
            $state = $null
            $journalGap = $false
            if ([IO.File]::Exists($StatePath)) {
                try {
                    $snapshot = Read-OwnedJournal $StatePath
                    Assert-KnownJobs $snapshot
                    Assert-CurrentWriter $snapshot
                    $state = $snapshot
                } catch {
                    # Untrusted/stale records grant no kill authority. Our own retained
                    # job handles ALWAYS remain authoritative, even across a writer gap.
                    if ($_.Exception.Message -like 'Stale launch journal;*') { $journalGap = $true }
                    else {
                        $cleanupIncomplete = $true
                        [Console]::Error.WriteLine($_.Exception.Message)
                    }
                }
            } else { $journalGap = $true }
            try { Stop-RetainedJobs $force $state }
            catch { $cleanupIncomplete = $true; [Console]::Error.WriteLine($_.Exception.Message) }
            if ($journalGap) {
                # Before the first write (or a replacement writer's first write), an
                # absent/stale snapshot is not incomplete if retained authority drained.
                foreach ($job in @($jobs.Values)) {
                    try { if ($job.Members().Length -gt 0) { $cleanupIncomplete = $true } }
                    catch { $cleanupIncomplete = $true }
                }
            }
            if ($stopRequested) {
                [Console]::WriteLine((@{ event = 'stopped'; incomplete = $cleanupIncomplete } | ConvertTo-Json -Compress))
            }
            $stopRequested = $false
        }
        if ($force) { break }
        Start-Sleep -Milliseconds 25
    }
} finally {
    $sentinelProcess.Dispose()
    # Unnamed handles originate here, not from files. Closing has NO implicit kill.
    foreach ($job in @($jobs.Values)) { $job.Dispose() }
    if ($null -ne $endingSince -and -not $cleanupIncomplete) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ($StatePath + '.tmp') -Force -ErrorAction SilentlyContinue
    } elseif ($cleanupIncomplete) {
        [Console]::Error.WriteLine('UIA cleanup incomplete; launch journal retained.')
    }
}
