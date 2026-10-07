# Headless session owner. Helper death/restart never means session end.
# This watchdog holds every authenticated launch job before the child may execute.
param(
    [switch] $Sentinel,
    [string] $StatePath,
    [int] $LifetimePid = 0,
    [string] $LifetimeStarted
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Get-ExactProcess($identity) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$identity.Pid)
        $null = $process.Handle
        if (-not $process.HasExited -and
            $process.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$identity.Started) {
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
        return ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks -ne [long]$identity.Started)
    } catch [ArgumentException] { return $true }
    catch { return $false }
    finally { if ($null -ne $process) { $process.Dispose() } }
}

if ($Sentinel) {
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try {
        $identity = @{ Pid = $PID; Started = $self.StartTime.ToUniversalTime().Ticks.ToString() }
        [Console]::WriteLine('UIA lifetime ready ' + ($identity | ConvertTo-Json -Compress))
    } finally { $self.Dispose() }
    while ($true) { Start-Sleep -Seconds 60 }
}

$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false, 4096, $true)
. "$PSScriptRoot/journal.ps1"
$script:journalKey = Read-JournalKey $reader
. "$PSScriptRoot/launch.ps1"
$lifetime = @{ Pid = $LifetimePid; Started = $LifetimeStarted }
$verified = Get-ExactProcess $lifetime
if ($null -eq $verified) { exit 1 }
$verified.Dispose()
$jobs = @{}
$cleanupIncomplete = $false
$endingSince = $null
$stopRequested = $false
# Writer provenance comes from the client's private pipe, not a replayable journal.
$script:writerIdentity = $null
[Console]::WriteLine('UIA watchdog ready')
$inputLine = $reader.ReadLineAsync()

function Assert-KnownJobs($state) {
    foreach ($name in $state.Jobs) {
        # Never reopen an object by a journal-supplied name/handle. An unavailable
        # owner means incomplete cleanup, not permission to guess a kernel object.
        if (-not $jobs.ContainsKey($name)) { throw 'Launch job owner unavailable; journal retained.' }
    }
}

function Assert-CurrentWriter($state) {
    if ($null -eq $script:writerIdentity -or
        $state.Helper.Pid -ne $script:writerIdentity.Pid -or
        $state.Helper.Started -cne $script:writerIdentity.Started) {
        throw 'Stale launch journal; cleanup refused; journal retained.'
    }
}

function Stop-CurrentWriter {
    # This identity came over the private client pipe, never from a journal. Explicit
    # stop/session end may always retire our own helper, even if its journal is missing
    # or corrupted. No launched app is killed without a verified cleanup snapshot.
    if ($null -eq $script:writerIdentity) {
        if ($jobs.Count -gt 0) { throw 'Current journal writer is unavailable; cleanup refused.' }
        return
    }
    $helper = Get-ExactProcess $script:writerIdentity
    if ($null -ne $helper) {
        try {
            $helper.Kill()
            if (-not $helper.WaitForExit(1000)) { throw 'Helper is still running.' }
        } finally { $helper.Dispose() }
    }
    if (-not (Test-IdentityGone $script:writerIdentity)) { throw 'Helper identity cannot be confirmed exited.' }
}

try {
    while ($true) {
        $sentinelProcess = Get-ExactProcess $lifetime
        $ending = $null -eq $sentinelProcess
        if ($null -ne $sentinelProcess) { $sentinelProcess.Dispose() }
        if ($inputLine.IsCompleted) {
            $line = $inputLine.GetAwaiter().GetResult()
            if ($null -eq $line) { $ending = $true }
            else {
                try {
                    $message = $line | ConvertFrom-Json
                    if ($message.event -ceq 'writer') {
                        $identity = @{ Pid = [int]$message.pid; Started = [string]$message.started }
                        $verified = Get-ExactProcess $identity
                        if ($null -eq $verified) { throw 'Current helper identity changed; launch refused.' }
                        $verified.Dispose()
                        $script:writerIdentity = $identity
                    } elseif ($message.event -ceq 'create-job') {
                        $state = Read-OwnedJournal $StatePath
                        Assert-CurrentWriter $state
                        Assert-KnownJobs $state
                        if ($message.job -isnot [string] -or $message.job -cnotmatch '^amira-uia-job-[0-9a-f-]{36}$' -or
                            $jobs.ContainsKey($message.job)) { throw 'Invalid launch job request.' }
                        $job = [OwnedUia.LaunchGuard]::CreateFor($message.job, [int]$state.Helper.Pid, [long]$state.Helper.Started)
                        $jobs[$message.job] = $job
                        [Console]::WriteLine((@{ event = 'job-created'; job = $message.job; handle = $job.HelperHandle } | ConvertTo-Json -Compress))
                    } elseif ($message.event -ceq 'stop') { $stopRequested = $true }
                } catch { [Console]::Error.WriteLine($_.Exception.Message) }
                $inputLine = $reader.ReadLineAsync()
            }
        }
        if ($ending -and $null -eq $endingSince) { $endingSince = [DateTime]::UtcNow }
        $force = $null -ne $endingSince -and ([DateTime]::UtcNow - $endingSince).TotalMilliseconds -ge 3000
        if ($stopRequested -or $force) {
            try {
                Stop-CurrentWriter
                # Only after our actual writer is gone take the MAC-verified snapshot.
                if ([IO.File]::Exists($StatePath)) {
                    $state = Read-OwnedJournal $StatePath
                    Assert-CurrentWriter $state
                    try { Assert-KnownJobs $state }
                    catch { $cleanupIncomplete = $true; [Console]::Error.WriteLine($_.Exception.Message) }
                    foreach ($job in @($jobs.Values)) {
                        try {
                            if ($force) { $job.Terminate() }
                            else { $job.StopHeadless() }
                        } catch {
                            $cleanupIncomplete = $true
                            [Console]::Error.WriteLine('Launch job cleanup incomplete; continuing other jobs.')
                        }
                    }
                    if ($force) {
                        foreach ($job in @($jobs.Values)) {
                            if ($job.Members().Length -gt 0) { throw 'Launch job cleanup is incomplete.' }
                        }
                        foreach ($identity in $state.Processes) {
                            if (-not (Test-IdentityGone $identity)) { throw 'Launch identity cleanup is incomplete.' }
                        }
                    }
                } elseif ($jobs.Count -gt 0) {
                    throw 'untrusted launch journal; cleanup refused (journal missing)'
                }
            } catch {
                $cleanupIncomplete = $true
                [Console]::Error.WriteLine($_.Exception.Message)
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
    # Unnamed handles originate here, not from files. Closing has NO implicit kill.
    foreach ($job in @($jobs.Values)) { $job.Dispose() }
    if ($null -ne $endingSince -and -not $cleanupIncomplete) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ($StatePath + '.tmp') -Force -ErrorAction SilentlyContinue
    } elseif ($cleanupIncomplete) {
        [Console]::Error.WriteLine('UIA cleanup incomplete; launch journal retained.')
    }
}
