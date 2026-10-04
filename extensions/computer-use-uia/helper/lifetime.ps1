# Headless lifecycle bridge, not a desktop/UIA client. The host kills the -Sentinel
# background job on unload. The openPipe watchdog independently reaps exact launch
# identities if the UIA helper crashes or hangs, even inside a synchronous UIA call.
param(
    [switch] $Sentinel,
    [string] $StatePath,
    [int] $LifetimePid = 0,
    [string] $LifetimeStarted
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
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
        # The original creation time travels with the PID; startup cannot bind a reused PID.
        $identity = @{ Pid = $PID; Started = $self.StartTime.ToUniversalTime().Ticks.ToString() }
        [Console]::WriteLine('UIA lifetime ready ' + ($identity | ConvertTo-Json -Compress))
    } finally { $self.Dispose() }
    while ($true) { Start-Sleep -Seconds 60 }
}

$lifetime = @{ Pid = $LifetimePid; Started = $LifetimeStarted }
$verified = Get-ExactProcess $lifetime
if ($null -eq $verified) { exit 1 }
$verified.Dispose()
[Console]::WriteLine('UIA watchdog ready')
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false, 4096, $true)
$inputLine = $reader.ReadLineAsync()
$endingSince = $null
$cleanupIncomplete = $false
try {
    while ($true) {
        $sentinelProcess = Get-ExactProcess $lifetime
        $ending = $null -eq $sentinelProcess -or $inputLine.IsCompleted
        if ($null -ne $sentinelProcess) { $sentinelProcess.Dispose() }
        if ($ending -and $null -eq $endingSince) { $endingSince = [DateTime]::UtcNow }
        # Give the helper three seconds for WindowPattern.Close; then enforce cleanup
        # without calling UIA (it may be the thing that is stuck).
        $force = $ending -and ([DateTime]::UtcNow - $endingSince).TotalMilliseconds -ge 3000
        try {
            if (Test-Path -LiteralPath $StatePath) {
                $state = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
                $helperProcess = Get-ExactProcess $state.Helper
                $helperDead = $null -eq $helperProcess
                if ($helperDead -or $force) {
                    $cleanupIncomplete = $false
                    foreach ($identity in $state.Processes) {
                        $process = Get-ExactProcess $identity
                        if ($null -ne $process) {
                            try {
                                $process.Kill()
                                if (-not $process.WaitForExit(1000)) { $cleanupIncomplete = $true }
                            } catch { $cleanupIncomplete = $true }
                            finally { $process.Dispose() }
                        } elseif (-not (Test-IdentityGone $identity)) { $cleanupIncomplete = $true }
                    }
                    if ($force -and $null -ne $helperProcess) {
                        try {
                            $helperProcess.Kill()
                            if (-not $helperProcess.WaitForExit(1000)) { $cleanupIncomplete = $true }
                        } catch { $cleanupIncomplete = $true }
                    } elseif ($force -and -not (Test-IdentityGone $state.Helper)) { $cleanupIncomplete = $true }
                }
                if ($null -ne $helperProcess) { $helperProcess.Dispose() }
            }
        } catch {
            # Atomic replacement may race this read; retry, never guess process identities.
            if ($force) { $cleanupIncomplete = $true }
        }
        if ($force) { break }
        Start-Sleep -Milliseconds 100
    }
} finally {
    # Only the private per-client journal. Do not delete while a replacement is running.
    if ($null -ne $endingSince -and -not $cleanupIncomplete) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ($StatePath + '.tmp') -Force -ErrorAction SilentlyContinue
    } elseif ($cleanupIncomplete) {
        # Retain the only record of unresolved launches; never kill a guessed PID.
        [Console]::Error.WriteLine('UIA cleanup incomplete; launch journal retained.')
    }
}
