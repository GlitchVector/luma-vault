# Creates the classifier virtualenv on Windows and verifies it can classify.
#
#   pnpm setup:python     (or)     powershell -File scripts/setup-python.ps1
#
# The app finds this venv by convention (<repo>\venv-classifier) or via the
# LUMA_PYTHON environment variable.
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$VenvPath = Join-Path $RepoRoot "venv-classifier"
$Requirements = Join-Path $RepoRoot "sidecar\classifier\requirements.txt"
$Worker = Join-Path $RepoRoot "sidecar\classifier\classify_worker.py"

# 3.12 first — see the note in setup-python.sh about 3.14 wheels.
#
# The probe runs with errors demoted rather than silenced: `py` writes to stderr
# for every version that is not installed, and under ErrorActionPreference=Stop
# a native command's stderr is a *terminating* error — so on a machine with only
# 3.11, probing for 3.12 would abort setup instead of falling through.
$PythonBin = $null
$ErrorActionPreference = "Continue"
foreach ($version in @("3.12", "3.13", "3.11")) {
    $candidate = & py "-$version" -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $candidate) { $PythonBin = "$candidate".Trim(); break }
}
$ErrorActionPreference = "Stop"

if (-not $PythonBin) {
    Write-Error "Need Python 3.11, 3.12 or 3.13. Install one: winget install Python.Python.3.12"
    exit 1
}

Write-Host "==> Using $PythonBin"

if (Test-Path $VenvPath) {
    # A half-created venv has no python.exe; treat that as "none" and recreate,
    # rather than letting the call itself abort the script.
    $VenvPython = Join-Path $VenvPath "Scripts\python.exe"
    $existing = "none"
    if (Test-Path $VenvPython) {
        $ErrorActionPreference = "Continue"
        $probed = & $VenvPython -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        $ErrorActionPreference = "Stop"
        if ($LASTEXITCODE -eq 0 -and $probed) { $existing = "$probed".Trim() }
    }
    $wanted = (& $PythonBin -c "import sys; print('%d.%d' % sys.version_info[:2])").Trim()
    if ($existing -ne $wanted) {
        Write-Host "==> Existing venv is Python $existing, want $wanted - recreating"
        Remove-Item -Recurse -Force $VenvPath
    }
}

if (-not (Test-Path $VenvPath)) {
    Write-Host "==> Creating venv at $VenvPath"
    & $PythonBin -m venv $VenvPath
}

Write-Host "==> Installing pinned requirements"
& "$VenvPath\Scripts\python.exe" -m pip install --upgrade pip --quiet
& "$VenvPath\Scripts\python.exe" -m pip install -r $Requirements --quiet

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "ffmpeg/ffprobe not found on PATH - videos cannot be scanned."
    Write-Warning "  winget install Gyan.FFmpeg"
}

Write-Host "==> Verifying the classifier can load its model"
& "$VenvPath\Scripts\python.exe" $Worker --check
if ($LASTEXITCODE -ne 0) {
    Write-Error "The classifier failed its self-check (see the JSON above)."
    exit 1
}

Write-Host ""
Write-Host "Classifier ready:  $VenvPath\Scripts\python.exe"
