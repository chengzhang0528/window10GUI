# Runs only after apphost reports a missing runtime. Compatible with Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# A caller running PowerShell 7 can pass a PSModulePath that shadows the
# Windows PowerShell modules. Resolve required OS modules from this host.
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules\$module\$module.psd1") -ErrorAction Stop
}

function Test-DesktopRuntime {
    # The probe exits before desktop initialization or business execution.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $PSScriptRoot 'app\win-agent.exe'
    $start.Arguments = '--runtime-probe'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { return $false }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); return $false }
        return $process.ExitCode -eq 0
    } finally { $process.Dispose() }
}

function Get-RuntimeInstaller($Spec, [string]$Destination) {
    Invoke-WebRequest -Uri $Spec.url -UseBasicParsing -TimeoutSec 180 -OutFile $Destination
}

function Confirm-RuntimeInstaller($Spec, [string]$Path) {
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash
    if ($actual -ne $Spec.sha512) { throw 'Runtime installer SHA-512 mismatch; no installer was executed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid') { throw 'Runtime installer signature is not valid; no installer was executed.' }
}

function Install-DesktopRuntime([string]$Installer) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $arguments = @{ FilePath = $Installer; ArgumentList = @('/install', '/quiet', '/norestart'); PassThru = $true; WindowStyle = 'Hidden' }
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $arguments.Verb = 'RunAs' }
    # Windows owns the elevation UI; no credentials are requested by DeskPilot.
    $process = Start-Process @arguments
    if (-not $process.WaitForExit(600000)) {
        throw 'Runtime installer is still running after 10 minutes. Inspect Windows installation before retrying.'
    }
    if ($process.ExitCode -eq 3010) { [Console]::Error.WriteLine('DeskPilot: runtime installer requested a Windows restart.') }
    elseif ($process.ExitCode -ne 0) { throw "Runtime installer failed with exit code $($process.ExitCode)." }
}

function Invoke-RuntimeSetup {
    $mutex = New-Object Threading.Mutex($false, 'Local\DeskPilot.DesktopRuntime10x64')
    $held = $false
    $downloadDir = $null
    try {
        try { $held = $mutex.WaitOne(600000) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another runtime preparation is still running; try again after it finishes.' }
        # A concurrent launcher may already have completed installation.
        if (Test-DesktopRuntime) { return }
        $spec = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-download.json') -Raw | ConvertFrom-Json
        $downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('DeskPilotRuntime-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $downloadDir | Out-Null
        $installer = Join-Path $downloadDir 'windowsdesktop-runtime.exe'
        [Console]::Error.WriteLine("DeskPilot: downloading Microsoft Desktop Runtime $($spec.version) x64.")
        Get-RuntimeInstaller $spec $installer
        Confirm-RuntimeInstaller $spec $installer
        Install-DesktopRuntime $installer
        if (-not (Test-DesktopRuntime)) { throw 'Runtime still unavailable after installation. A restart or installer repair may be required.' }
        [Console]::Error.WriteLine('DeskPilot: runtime is ready; subsequent launches skip setup.')
    } finally {
        if ($downloadDir) {
            # Only this invocation's uniquely created download directory is owned.
            $resolved = [IO.Path]::GetFullPath($downloadDir)
            $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
            if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -match '^DeskPilotRuntime-[0-9a-f]{32}$') {
                Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-RuntimeSetup; exit 0 }
    catch { [Console]::Error.WriteLine('DeskPilot runtime preparation failed: ' + $_.Exception.Message); exit 20 }
}
