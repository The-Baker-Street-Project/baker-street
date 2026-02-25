<#
.SYNOPSIS
    Deploy Baker Street from Windows PowerShell via WSL.

.DESCRIPTION
    Checks prerequisites (WSL2, Docker Desktop, Kubernetes), prompts for
    secrets, then delegates to the existing bash deploy pipeline inside WSL.

.EXAMPLE
    .\Deploy-BakerStreet.ps1
    .\Deploy-BakerStreet.ps1 -SkipSecrets -SkipTelemetry -SkipExtensions
    .\Deploy-BakerStreet.ps1 -Yes
#>
[CmdletBinding()]
param(
    [switch]$SkipSecrets,
    [switch]$SkipBuild,
    [switch]$SkipImages,
    [switch]$SkipTelemetry,
    [switch]$SkipExtensions,
    [switch]$Dev,
    [string]$Version,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

# --- Helpers -----------------------------------------------------------

function Write-Banner {
    param([string]$Text)
    Write-Host ""
    Write-Host ("=" * 62) -ForegroundColor Blue
    Write-Host "  $Text" -ForegroundColor White
    Write-Host ("=" * 62) -ForegroundColor Blue
}

function Write-Step {
    param([string]$Text)
    Write-Host "`n==> $Text" -ForegroundColor Green
}

function Write-Info {
    param([string]$Text)
    Write-Host "    $Text" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Text)
    Write-Host "    [!] $Text" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host "`nERROR: $Text" -ForegroundColor Red
    exit 1
}

function Read-Secret {
    param([string]$Prompt, [string]$Default)
    if ($Yes -and $Default) { return $Default }
    $suffix = if ($Default) { " [****$($Default.Substring([Math]::Max(0, $Default.Length - 4)))]" } else { "" }
    $secure = Read-Host -Prompt "    ${Prompt}${suffix}" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr)
    }
    if (-not $plain -and $Default) { return $Default }
    return $plain
}

function Read-Value {
    param([string]$Prompt, [string]$Default)
    if ($Yes -and $Default) { return $Default }
    $suffix = if ($Default) { " [$Default]" } else { "" }
    $answer = Read-Host -Prompt "    ${Prompt}${suffix}"
    if (-not $answer -and $Default) { return $Default }
    return $answer
}

function Confirm-Prompt {
    param([string]$Prompt, [bool]$DefaultYes = $true)
    if ($Yes) { return $DefaultYes }
    $hint = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
    $answer = Read-Host -Prompt "    $Prompt $hint"
    if (-not $answer) { return $DefaultYes }
    return $answer -match '^[Yy]'
}

# Resolve repo root (parent of scripts/)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# ===================================================================
# Phase 1: Prerequisite Checks
# ===================================================================
Write-Banner "Baker Street Deploy (Windows)"

Write-Step "Checking prerequisites..."

# --- WSL2 ---
$wslAvailable = $false
try {
    $null = wsl --status 2>&1
    $wslAvailable = $LASTEXITCODE -eq 0
} catch {
    $wslAvailable = $false
}

if (-not $wslAvailable) {
    Write-Fail @"
WSL2 is not installed or not running.

    To install WSL2:
    1. Open PowerShell as Administrator
    2. Run: wsl --install
    3. Restart your computer
    4. Run this script again
"@
}

# Check WSL has at least one distro
$distros = (wsl --list --quiet 2>&1) |
    ForEach-Object { ($_ -replace '\x00', '').Trim() } |
    Where-Object { $_ -ne '' }
if (-not $distros) {
    Write-Fail @"
No WSL distributions found.

    To install Ubuntu:
    1. Run: wsl --install -d Ubuntu
    2. Follow the setup prompts
    3. Run this script again
"@
}
Write-Info "WSL2: OK"

# --- Docker Desktop ---
$dockerOk = $false
try {
    $null = docker info 2>&1
    $dockerOk = $LASTEXITCODE -eq 0
} catch {
    $dockerOk = $false
}

if (-not $dockerOk) {
    Write-Fail @"
Docker Desktop is not running.

    1. Open Docker Desktop from the Start menu
    2. Wait for it to finish starting (whale icon stops animating)
    3. Run this script again

    If Docker Desktop is not installed:
      winget install Docker.DockerDesktop
    Then restart your computer and enable WSL2 backend in Docker Desktop settings.
"@
}
Write-Info "Docker Desktop: OK"

# --- Kubernetes ---
$kubeOk = $false
try {
    $null = kubectl cluster-info 2>&1
    $kubeOk = $LASTEXITCODE -eq 0
} catch {
    $kubeOk = $false
}

if (-not $kubeOk) {
    Write-Fail @"
Kubernetes is not available.

    To enable Kubernetes in Docker Desktop:
    1. Open Docker Desktop
    2. Go to Settings (gear icon) > Kubernetes
    3. Check "Enable Kubernetes"
    4. Click "Apply & Restart"
    5. Wait for the Kubernetes status indicator to turn green
    6. Run this script again
"@
}
Write-Info "Kubernetes: OK ($(kubectl config current-context 2>&1))"

# ===================================================================
# Phase 2: Secrets Configuration
# ===================================================================
$envFile = Join-Path $RepoRoot '.env-secrets'
$secrets = @{}

# Load existing .env-secrets
if (Test-Path $envFile) {
    Write-Step "Loading existing .env-secrets"
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^([A-Z_]+)=(.*)$') {
            $secrets[$Matches[1]] = $Matches[2]
        }
    }
    Write-Info "Loaded $($secrets.Count) variables"
}

if (-not $SkipSecrets) {
    Write-Banner "Secrets Configuration"

    # --- Anthropic auth ---
    Write-Step "Anthropic authentication (required)"

    $hasAnthropic = $false
    if ($secrets['ANTHROPIC_OAUTH_TOKEN']) {
        Write-Info "ANTHROPIC_OAUTH_TOKEN is set (****$($secrets['ANTHROPIC_OAUTH_TOKEN'].Substring($secrets['ANTHROPIC_OAUTH_TOKEN'].Length - 4)))"
        $hasAnthropic = $true
    }
    if ($secrets['ANTHROPIC_API_KEY']) {
        Write-Info "ANTHROPIC_API_KEY is set (****$($secrets['ANTHROPIC_API_KEY'].Substring($secrets['ANTHROPIC_API_KEY'].Length - 4)))"
        $hasAnthropic = $true
    }

    if (-not $hasAnthropic) {
        Write-Warn "No Anthropic credentials found."
        Write-Info "Provide either an OAuth token (preferred) or an API key."
        $token = Read-Secret "ANTHROPIC_OAUTH_TOKEN (or press Enter for API key)"
        if ($token) {
            $secrets['ANTHROPIC_OAUTH_TOKEN'] = $token
        } else {
            $key = Read-Secret "ANTHROPIC_API_KEY"
            if (-not $key) {
                Write-Fail "At least one of ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY is required."
            }
            $secrets['ANTHROPIC_API_KEY'] = $key
        }
    }

    # --- Voyage ---
    Write-Step "Voyage AI (embeddings)"
    if ($secrets['VOYAGE_API_KEY']) {
        Write-Info "VOYAGE_API_KEY is set (****$($secrets['VOYAGE_API_KEY'].Substring($secrets['VOYAGE_API_KEY'].Length - 4)))"
    } else {
        $voyage = Read-Secret "VOYAGE_API_KEY (optional, press Enter to skip)"
        if ($voyage) { $secrets['VOYAGE_API_KEY'] = $voyage }
        else { Write-Warn "Skipped - embeddings will not be available." }
    }

    # --- Telegram ---
    Write-Step "Telegram gateway (optional)"
    if ($secrets['TELEGRAM_BOT_TOKEN']) {
        Write-Info "TELEGRAM_BOT_TOKEN is set (****$($secrets['TELEGRAM_BOT_TOKEN'].Substring($secrets['TELEGRAM_BOT_TOKEN'].Length - 4)))"
    } elseif (-not $Yes -and (Confirm-Prompt "Configure Telegram bot?" $false)) {
        $tgToken = Read-Secret "TELEGRAM_BOT_TOKEN"
        if ($tgToken) {
            $secrets['TELEGRAM_BOT_TOKEN'] = $tgToken
            $tgChats = Read-Value "TELEGRAM_ALLOWED_CHAT_IDS (comma-separated)" $secrets['TELEGRAM_ALLOWED_CHAT_IDS']
            if ($tgChats) { $secrets['TELEGRAM_ALLOWED_CHAT_IDS'] = $tgChats }
        }
    } else {
        Write-Info "Skipped"
    }

    # --- Discord ---
    Write-Step "Discord gateway (optional)"
    if ($secrets['DISCORD_BOT_TOKEN']) {
        Write-Info "DISCORD_BOT_TOKEN is set (****$($secrets['DISCORD_BOT_TOKEN'].Substring($secrets['DISCORD_BOT_TOKEN'].Length - 4)))"
    } elseif (-not $Yes -and (Confirm-Prompt "Configure Discord bot?" $false)) {
        $dcToken = Read-Secret "DISCORD_BOT_TOKEN"
        if ($dcToken) {
            $secrets['DISCORD_BOT_TOKEN'] = $dcToken
            $dcChans = Read-Value "DISCORD_ALLOWED_CHANNEL_IDS (comma-separated)" $secrets['DISCORD_ALLOWED_CHANNEL_IDS']
            if ($dcChans) { $secrets['DISCORD_ALLOWED_CHANNEL_IDS'] = $dcChans }
        }
    } else {
        Write-Info "Skipped"
    }

    # --- AUTH_TOKEN ---
    Write-Step "Auth token"
    if (-not $secrets['AUTH_TOKEN']) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $secrets['AUTH_TOKEN'] = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        Write-Info "Generated new AUTH_TOKEN"
    } else {
        Write-Info "Using existing AUTH_TOKEN (****$($secrets['AUTH_TOKEN'].Substring($secrets['AUTH_TOKEN'].Length - 4)))"
    }

    # --- AGENT_NAME ---
    Write-Step "Agent persona name"
    $agentName = Read-Value "Agent persona name" ($secrets['AGENT_NAME'] ?? 'Baker')
    if ($agentName) { $secrets['AGENT_NAME'] = $agentName }

    # --- Save .env-secrets ---
    Write-Step "Saving secrets to .env-secrets"
    $lines = @()
    $orderedKeys = @(
        'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
        'VOYAGE_API_KEY',
        'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS',
        'DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_CHANNEL_IDS',
        'AUTH_TOKEN', 'AGENT_NAME'
    )
    foreach ($key in $orderedKeys) {
        if ($secrets[$key]) {
            $lines += "$key=$($secrets[$key])"
        }
    }
    # Write without BOM — PS 5.1's -Encoding UTF8 adds a BOM which breaks bash source
    [System.IO.File]::WriteAllLines($envFile, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Info "Saved to .env-secrets"

} else {
    Write-Step "Skipping secrets configuration (-SkipSecrets)"
    if (-not $secrets['AUTH_TOKEN']) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $secrets['AUTH_TOKEN'] = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        Add-Content -Path $envFile -Value "AUTH_TOKEN=$($secrets['AUTH_TOKEN'])"
    }
}

# ===================================================================
# Phase 3: Path Conversion
# ===================================================================
Write-Step "Converting paths for WSL..."

$winPath = $RepoRoot -replace '\\', '/'
$wslPath = (wsl wslpath -u "$winPath" 2>&1).Trim()

if ($LASTEXITCODE -ne 0) {
    Write-Fail "Failed to convert path to WSL format: $wslPath"
}
Write-Info "Repo path (WSL): $wslPath"

# ===================================================================
# Phase 4: Delegate to WSL
# ===================================================================
Write-Banner "Build & Deploy (via WSL)"

# Build the argument list for deploy-all.sh
$bashArgs = @('--skip-secrets', '-y')

if ($SkipBuild)     { $bashArgs += '--skip-build' }
if ($SkipImages)    { $bashArgs += '--skip-images' }
if ($SkipTelemetry)  { $bashArgs += '--skip-telemetry' }
if ($SkipExtensions) { $bashArgs += '--skip-extensions' }
if ($Dev)            { $bashArgs += '--dev' }
if ($Version)       { $bashArgs += '--version'; $bashArgs += $Version }

# Escape single quotes in path for bash
$escapedPath = $wslPath -replace "'", "'\\''"
$bashCmd = "cd '$escapedPath' && bash scripts/deploy-all.sh $($bashArgs -join ' ')"

Write-Info "Running: bash scripts/deploy-all.sh $($bashArgs -join ' ')"
Write-Host ""

# Execute in WSL, streaming output in real-time
wsl bash -c "$bashCmd"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Warn "Deploy failed with exit code $LASTEXITCODE"
    Write-Host ""
    Write-Host "    Troubleshooting:" -ForegroundColor Yellow
    Write-Host "    - Check Docker Desktop is running and Kubernetes is enabled" -ForegroundColor Yellow
    Write-Host "    - Try: wsl bash -c 'kubectl get nodes'" -ForegroundColor Yellow
    Write-Host "    - Check WSL has enough memory (see .wslconfig)" -ForegroundColor Yellow
    Write-Host "    - View logs: wsl bash -c 'kubectl logs -n bakerst deployment/<name>'" -ForegroundColor Yellow
    exit $LASTEXITCODE
}

# ===================================================================
# Final Summary
# ===================================================================
Write-Host ""
Write-Banner "Ready!"
Write-Host ""
Write-Host "    Open in your browser:" -ForegroundColor White
Write-Host "    http://localhost:30080" -ForegroundColor Cyan
Write-Host ""
if ($secrets['AUTH_TOKEN']) {
    Write-Host "    Auth token: ****$($secrets['AUTH_TOKEN'].Substring($secrets['AUTH_TOKEN'].Length - 4))" -ForegroundColor Cyan
    Write-Host "    (Full token is in .env-secrets)" -ForegroundColor DarkGray
}
Write-Host ""
