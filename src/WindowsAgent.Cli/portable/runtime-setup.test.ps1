# Deterministic tests: no network requests, runtime installation or elevation.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-runtime.ps1')
$realConfirm = ${function:Confirm-RuntimeInstaller}
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }

foreach ($case in @('installed', 'success', 'download-failed', 'hash-mismatch', 'install-cancelled', 'install-failed', 'postcheck-failed')) {
    $script:currentCase = $case
    $script:probes = 0
    $script:downloads = 0
    $script:installs = 0
    function Test-DesktopRuntime {
        $script:probes++
        return $script:currentCase -eq 'installed' -or ($script:currentCase -eq 'success' -and $script:probes -gt 1)
    }
    function Get-RuntimeInstaller($Spec, $Destination) {
        $script:downloads++
        if ($script:currentCase -eq 'download-failed') { throw 'test network outage' }
        [IO.File]::WriteAllText($Destination, 'deliberately not an installer')
    }
    function Confirm-RuntimeInstaller($Spec, $Path) {
        if ($script:currentCase -eq 'hash-mismatch') { & $realConfirm $Spec $Path }
    }
    function Install-DesktopRuntime($Installer) {
        $script:installs++
        if ($script:currentCase -eq 'install-cancelled') { throw 'test UAC declined' }
        if ($script:currentCase -eq 'install-failed') { throw 'test installer failure' }
    }
    $failure = $null
    try { Invoke-RuntimeSetup } catch { $failure = $_ }
    if ($case -in @('installed', 'success')) { Assert ($null -eq $failure) "$case unexpectedly failed: $failure" }
    else { Assert ($null -ne $failure) "$case unexpectedly succeeded" }
    if ($case -eq 'installed') { Assert ($script:downloads -eq 0 -and $script:installs -eq 0) 'existing runtime was not reused' }
    if ($case -in @('download-failed', 'hash-mismatch')) { Assert ($script:installs -eq 0) 'unverified download was executed' }
    if ($case -eq 'hash-mismatch') { Assert ($failure.Exception.Message -match 'SHA-512 mismatch') ('wrong integrity failure: ' + $failure.Exception.Message) }
    if ($case -eq 'success') { Assert ($script:probes -eq 2 -and $script:installs -eq 1) 'success was not re-probed' }
}
Write-Output '7 setup decisions passed'
