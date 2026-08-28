<#
.SYNOPSIS
    Idempotently provisions the dedicated "kirofactory-docker" WSL2 distro and
    installs Docker Engine inside it, for running local KiroFactory worker
    sessions (see ARCHITECTURE.md §12 and worker/.devcontainer/README.md).

.DESCRIPTION
    This distro is dedicated to KiroFactory's local worker sessions — kept
    separate from any general-purpose WSL/Ubuntu distro a developer already
    has. It runs Docker Engine directly (get.docker.com convenience script),
    not Docker Desktop.

    Safe to re-run: every step checks whether it's already satisfied before
    acting, so this can run on every local session start (via a cheap health
    check) or be invoked manually to fix a broken distro.

.PARAMETER DistroName
    Name of the dedicated WSL distro. Defaults to "kirofactory-docker".

.PARAMETER BaseDistro
    The WSL distro to install as the base, via `wsl --install -d <BaseDistro>
    --name <DistroName>`. Defaults to "Ubuntu-24.04" (minimal Ubuntu base +
    Docker Engine — see ARCHITECTURE.md §12 "Base image decision").

.PARAMETER CheckOnly
    If set, only checks whether the distro exists and Docker is responding
    inside it. Does not create or install anything. Exits with code 0 if
    healthy, 1 otherwise. Intended for cheap health checks from
    wsl-worker-spawner.ts before every local session start.

.EXAMPLE
    ./setup-wsl.ps1
    Provisions (or verifies) the kirofactory-docker distro with Docker Engine.

.EXAMPLE
    ./setup-wsl.ps1 -CheckOnly
    Health-check only; does not modify anything.
#>

param(
    [string]$DistroName = "kirofactory-docker",
    [string]$BaseDistro = "Ubuntu-24.04",
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

# wsl.exe writes its stdout as UTF-16LE regardless of the console's active
# code page (a documented wsl.exe/winget.exe quirk). Windows PowerShell's
# default decode of external-process output does not always match this
# (observed here: legacy single-byte codepage decode), which corrupts every
# line captured from `wsl.exe -l -v` / `wsl.exe -d ... -- ...` with
# interleaved null bytes — breaking string comparisons like Test-DistroExists
# even though the printed text looks correct to the eye. Setting
# [Console]::OutputEncoding (the *read-side* decode PowerShell uses for
# captured external-process output — not $OutputEncoding, which only affects
# what PowerShell writes *to* external processes) to UTF-16LE makes it decode
# wsl.exe's actual byte stream correctly, regardless of the host's console/
# codepage defaults.
[Console]::OutputEncoding = [System.Text.Encoding]::Unicode

function Write-Step {
    param([string]$Message)
    Write-Host "[setup-wsl] $Message"
}

function Test-DistroExists {
    param([string]$Name)
    # `wsl -l -v` prints UTF-16LE with a null-padded table; -Contains match on
    # trimmed lines avoids depending on exact column alignment.
    $lines = (wsl.exe -l -v 2>$null) | ForEach-Object { $_.Trim() }
    return ($lines | Where-Object { $_ -match "^\*?\s*$([regex]::Escape($Name))\s" -or $_ -eq $Name }).Count -gt 0
}

function Test-DockerHealthy {
    param([string]$Name)
    try {
        wsl.exe -d $Name -- docker info *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# Health-check-only mode (cheap path called before every local session start)
# ---------------------------------------------------------------------------
if ($CheckOnly) {
    if (-not (Test-DistroExists -Name $DistroName)) {
        Write-Step "Distro '$DistroName' does not exist."
        exit 1
    }
    if (-not (Test-DockerHealthy -Name $DistroName)) {
        Write-Step "Distro '$DistroName' exists but Docker is not responding."
        exit 1
    }
    Write-Step "Distro '$DistroName' exists and Docker is healthy."
    exit 0
}

# ---------------------------------------------------------------------------
# Full provisioning
# ---------------------------------------------------------------------------

Write-Step "Checking for dedicated WSL distro '$DistroName'..."

if (-not (Test-DistroExists -Name $DistroName)) {
    Write-Step "Not found. Creating '$DistroName' from base '$BaseDistro'..."
    wsl.exe --install -d $BaseDistro --name $DistroName --no-launch
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create WSL distro '$DistroName' from base '$BaseDistro' (exit code $LASTEXITCODE)."
    }
    Write-Step "Distro '$DistroName' created."
} else {
    Write-Step "Distro '$DistroName' already exists."
}

Write-Step "Checking Docker Engine inside '$DistroName'..."

$dockerInstalled = $false
try {
    wsl.exe -d $DistroName -- which docker *> $null
    $dockerInstalled = ($LASTEXITCODE -eq 0)
} catch {
    $dockerInstalled = $false
}

if (-not $dockerInstalled) {
    Write-Step "Docker Engine not found. Installing via get.docker.com..."
    # get.docker.com installs Docker Engine (not Docker Desktop) directly into
    # the distro. Requires the distro to have network access and a package
    # manager (apt, present on Ubuntu bases).
    wsl.exe -d $DistroName -- bash -c "curl -fsSL https://get.docker.com | sh"
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Engine installation failed inside '$DistroName' (exit code $LASTEXITCODE)."
    }
    Write-Step "Docker Engine installed."
} else {
    Write-Step "Docker Engine already installed."
}

Write-Step "Ensuring the Docker daemon is running inside '$DistroName'..."

if (-not (Test-DockerHealthy -Name $DistroName)) {
    # WSL distros don't run systemd by default unless the distro opts in, so
    # start dockerd directly rather than assuming `service docker start` works.
    Write-Step "Docker daemon not responding. Starting dockerd..."
    wsl.exe -d $DistroName -- bash -c "sudo service docker start || sudo dockerd > /var/log/dockerd.log 2>&1 &"
    Start-Sleep -Seconds 3

    if (-not (Test-DockerHealthy -Name $DistroName)) {
        throw "Docker daemon did not start inside '$DistroName'. Check /var/log/dockerd.log inside the distro (wsl -d $DistroName -- cat /var/log/dockerd.log)."
    }
}

Write-Step "Docker Engine is running inside '$DistroName'. Setup complete."
