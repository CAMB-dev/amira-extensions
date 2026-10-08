# Shared authenticated journal codec. The key arrives once over stdin, never in a file/argv/env.
function Read-JournalKey($reader) {
    try {
        $bootstrap = $reader.ReadLine() | ConvertFrom-Json
        $key = [Convert]::FromBase64String($bootstrap.key)
        if ($bootstrap.event -cne 'journal-key' -or $key.Length -ne 32 -or
            $bootstrap.nonce -isnot [string] -or $bootstrap.nonce -cnotmatch '^[0-9a-f-]{36}$') { throw 'Invalid key' }
        $script:journalNonce = $bootstrap.nonce
        return ,$key
    } catch { throw 'untrusted launch journal; cleanup refused' }
}

function Get-JournalMac([string] $content) {
    $hmac = [Security.Cryptography.HMACSHA256]::new($script:journalKey)
    try { return ,$hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($content)) }
    finally { $hmac.Dispose() }
}

function Read-OwnedJournal([string] $path) {
    try {
        $envelope = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        if ($envelope.Content -isnot [string] -or $envelope.Mac -isnot [string]) { throw 'Invalid envelope' }
        $expected = Get-JournalMac $envelope.Content
        $actual = [Convert]::FromBase64String($envelope.Mac)
        if ($actual.Length -ne 32) { throw 'Invalid MAC length' }
        # .NET Framework lacks FixedTimeEquals. Compare all 32 bytes, without an early exit.
        $difference = 0
        for ($i = 0; $i -lt 32; $i++) { $difference = $difference -bor ($actual[$i] -bxor $expected[$i]) }
        if ($difference -ne 0) { throw 'Invalid MAC' }
        $state = $envelope.Content | ConvertFrom-Json
        if ($state.Nonce -cne $script:journalNonce -or $state.StatePath -cne $path) { throw 'Session mismatch' }
        if ($state.OwnershipVersion -isnot [int] -or $state.OwnershipVersion -ne 3 -or $null -eq $state.Helper -or
            $state.Processes -isnot [System.Array] -or $state.Jobs -isnot [System.Array]) { throw 'Invalid schema' }
        foreach ($identity in (@($state.Helper) + @($state.Processes))) {
            $processId = 0
            $started = 0L
            if (-not [int]::TryParse([string]$identity.Pid, [ref]$processId) -or $processId -le 0 -or
                -not [long]::TryParse([string]$identity.Started, [ref]$started) -or $started -le 0) { throw 'Invalid identity' }
        }
        foreach ($name in $state.Jobs) {
            if ($name -isnot [string] -or $name -cnotmatch '^amira-uia-job-[0-9a-f-]{36}$') { throw 'Invalid job' }
        }
        return $state
    } catch { throw 'untrusted launch journal; cleanup refused' }
}

function Write-OwnedJournal([string] $path, $state) {
    $state.Nonce = $script:journalNonce
    $state.StatePath = $path
    $content = $state | ConvertTo-Json -Depth 5 -Compress
    $envelope = @{ Content = $content; Mac = [Convert]::ToBase64String((Get-JournalMac $content)) } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($path + '.tmp', $envelope, $utf8)
    if ([IO.File]::Exists($path)) { [IO.File]::Replace($path + '.tmp', $path, [NullString]::Value) }
    else { [IO.File]::Move($path + '.tmp', $path) }
}
