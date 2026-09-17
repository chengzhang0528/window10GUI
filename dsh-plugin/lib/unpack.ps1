# Private extraction helper. Archive bytes have already passed the pinned digest check.
param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
if (-not [IO.Directory]::Exists($root)) { throw 'Extraction destination must already exist.' }
if ([IO.Directory]::EnumerateFileSystemEntries($root).GetEnumerator().MoveNext()) { throw 'Extraction destination must be empty.' }
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    if ($zip.Entries.Count -gt 10000) { throw 'Too many archive entries.' }
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        $parts = $name.TrimEnd('/').Split('/')
        if (-not $name -or $name.StartsWith('/') -or $name.Contains(':')) { throw 'Unsafe archive path.' }
        foreach ($part in $parts) {
            if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)' -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Unsafe archive path segment.' }
        }
        if (-not $seen.Add($name.TrimEnd('/'))) { throw 'Duplicate archive path.' }
        $unixType = ($entry.ExternalAttributes -shr 16) -band 61440
        if ($unixType -notin @(0, 32768, 16384) -or ($entry.ExternalAttributes -band 1024)) { throw 'Archive links or special files are not supported.' }
        $target = [IO.Path]::GetFullPath((Join-Path $root $name))
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination.' }
        $total += $entry.Length
        if ($total -gt 536870912) { throw 'Expanded archive exceeds 512 MiB.' }
        if ($name.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        $inputStream = $entry.Open()
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
        try {
            $buffer = New-Object byte[] 65536
            [long]$written = 0
            while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $written += $count
                if ($written -gt $entry.Length) { throw 'Archive entry exceeds declared size.' }
                $outputStream.Write($buffer, 0, $count)
            }
            if ($written -ne $entry.Length) { throw 'Archive entry is truncated.' }
        } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
} finally { $zip.Dispose() }
