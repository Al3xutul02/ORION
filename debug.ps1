<#
.SYNOPSIS
    Rebuilds and (re)starts the all-in-one ORION container (Angular Frontend + FastAPI Backend + MySQL 8.0).

.DESCRIPTION
    1. Builds the root Dockerfile (Angular Frontend + FastAPI Backend + MySQL 8.0).
    2. Removes any previous 'orion' container and starts a fresh one connected to the 'orion-data' volume.
    3. Waits until both the FastAPI Backend (:8000/health) and Angular Frontend (:4200) are answering HTTP requests.
    4. Follows the container logs (Ctrl+C stops following, the container keeps running).

.EXAMPLE
    .\debug.ps1                  # build + run + follow logs
    .\debug.ps1 -NoLogs          # build + run, return to the prompt
    .\debug.ps1 -ExposeDb        # also publish MySQL on localhost:3307
    .\debug.ps1 -ResetDb         # wipe the persistent database volume before starting
    .\debug.ps1 -Stop            # stop and remove the container
#>
param(
    [int]$FrontendPort = 4200,
    [int]$BackendPort = 8000,
    [switch]$ExposeDb,
    [int]$DbPort = 3307,   # 3306 may be taken by a MySQL server installed on Windows
    [switch]$NoLogs,
    [switch]$ResetDb,
    [switch]$Stop
)

$Name  = 'orion'
$Image = 'orion:latest'

# Always run from the project root (the Docker build context).
Set-Location $PSScriptRoot

function Fail-Script([string]$Message) {
    Write-Host "`nERROR: $Message" -ForegroundColor Red
    if (-not $NoLogs -and $Host.Name -eq 'ConsoleHost') {
        Read-Host "`nPress Enter to close"
    }
    exit 1
}

function Remove-OldContainer {
    if (docker ps -aq --filter "name=^$Name$") {
        Write-Host "Removing existing '$Name' container..." -ForegroundColor DarkGray
        docker rm -f $Name *> $null
        Start-Sleep -Seconds 2
    }
}

if ($Stop) {
    Remove-OldContainer
    Write-Host "Stopped." -ForegroundColor Green
    return
}

docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail-Script "Docker isn't running. Start Docker Desktop first." }

Write-Host "Building $Image (Angular Frontend + FastAPI Backend + MySQL 8.0)..." -ForegroundColor Cyan
docker build -f Dockerfile -t $Image .
if ($LASTEXITCODE -ne 0) { Fail-Script "Docker build failed." }

Remove-OldContainer

if ($ResetDb) {
    Write-Host "Resetting database volume..." -ForegroundColor DarkGray
    docker volume rm orion-data *> $null
}

# Fail early with a readable message if a host port is already taken.
$ports = @($FrontendPort, $BackendPort)
if ($ExposeDb) { $ports += $DbPort }
foreach ($p in $ports) {
    $owner = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($owner) {
        $proc = (Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Fail-Script "Port $p is already in use by '$proc' (PID $($owner.OwningProcess)). Pick another with -FrontendPort / -BackendPort / -DbPort."
    }
}

$runArgs = @(
    'run', '-d',
    '--name', $Name,
    '-p', "${FrontendPort}:4200",
    '-p', "${BackendPort}:8000",
    '-v', 'orion-data:/var/lib/mysql'
)
if ($ExposeDb) { $runArgs += @('-p', "127.0.0.1:${DbPort}:3306") }

# MAVLink bridge: simulated drones go to QGroundControl on the host (UDP 14550);
# external vehicles (SITL, QGC forwarding) come in on UDP 14560.
$runArgs += @('-p', '14560:14560/udp', '-e', 'MAVLINK_OUT_HOST=host.docker.internal')

# Forward ANTHROPIC_API_KEY if present in host env or Backend/.env so the AAR Copilot works inside the container.
$apiKey = $env:ANTHROPIC_API_KEY
if (-not $apiKey -and (Test-Path "$PSScriptRoot\Backend\.env")) {
    $envLine = Get-Content "$PSScriptRoot\Backend\.env" | Where-Object { $_ -match '^\s*ANTHROPIC_API_KEY\s*=\s*(.+)$' } | Select-Object -First 1
    if ($envLine -match '^\s*ANTHROPIC_API_KEY\s*=\s*(.+)$') {
        $apiKey = $Matches[1].Trim().Trim('"').Trim("'")
    }
}
if ($apiKey) {
    $runArgs += @('-e', "ANTHROPIC_API_KEY=$apiKey")
}

$runArgs += $Image

Write-Host "Starting container..." -ForegroundColor Cyan
docker @runArgs | Out-Null
if ($LASTEXITCODE -ne 0) { Fail-Script "Failed to start the container." }

# Wait for Backend and Frontend to answer (MySQL init + schema creation take ~10-20s).
$backendUrl  = "http://localhost:$BackendPort/health"
$frontendUrl = "http://localhost:$FrontendPort"
$deadline    = (Get-Date).AddSeconds(120)
$ready       = $false

while ((Get-Date) -lt $deadline) {
    $state = docker inspect -f '{{.State.Running}}' $Name 2> $null
    if ($state -ne 'true') { break }
    try {
        Invoke-WebRequest $backendUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
        Invoke-WebRequest $frontendUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $ready) {
    Write-Host "`nThe app didn't come up. Last log lines:" -ForegroundColor Red
    docker logs --tail 40 $Name
    Fail-Script "Container exited before becoming healthy."
}

$pw = (docker logs $Name 2>&1 | Select-String 'Generated MySQL password' | Select-Object -Last 1)
Write-Host ""
Write-Host "Frontend (Ground Control): $frontendUrl" -ForegroundColor Green
Write-Host "Backend API & Swagger:     http://localhost:$BackendPort/docs" -ForegroundColor Green
if ($pw) { Write-Host ($pw.Line -replace '^\[start\]\s*', '') -ForegroundColor DarkGray }
if ($ExposeDb) { Write-Host "MySQL:                     127.0.0.1:$DbPort (db: orion_gcs, user: orion)" -ForegroundColor DarkGray }
Write-Host "Stop:                      .\debug.ps1 -Stop" -ForegroundColor DarkGray

if (-not $NoLogs) {
    Write-Host "`nFollowing logs (Ctrl+C to stop following; the container keeps running)...`n" -ForegroundColor DarkGray
    docker logs -f --since 1s $Name
}
