# Windows Deploy Script Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a PowerShell deploy script (`Deploy-BakerStreet.ps1`) and batch launcher (`deploy.bat`) that lets Windows users deploy Baker Street from PowerShell, delegating build/deploy to the existing bash pipeline via WSL.

**Architecture:** Thin WSL wrapper. PowerShell handles prerequisite checks with guided fix instructions, secrets prompting with masked input, and path conversion. Then delegates to `wsl bash scripts/deploy-all.sh --skip-secrets -y` for actual build/deploy. One source of truth for deploy logic stays in bash.

**Tech Stack:** PowerShell 5.1+ (ships with Windows), WSL2, existing bash scripts.

**Design doc:** `docs/plans/2026-02-23-windows-deploy-script-design.md`

---

### Task 1: Create `deploy.bat` launcher

**Files:**
- Create: `scripts/deploy.bat`

**Step 1: Write the batch launcher**

```batch
@echo off
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0Deploy-BakerStreet.ps1" %*
```

This is 2 lines. It:
- Bypasses execution policy so users don't need to configure it
- `-NoProfile` skips loading user PS profile (faster, predictable)
- `%~dp0` resolves to the directory containing the .bat file
- `%*` passes all arguments through to the PS script

**Step 2: Verify file created**

Run (from PowerShell): `Get-Content scripts\deploy.bat`
Expected: The 2 lines above.

**Step 3: Commit**

```bash
git add scripts/deploy.bat
git commit -m "feat: add deploy.bat launcher for Windows users"
```

---

### Task 2: Create `Deploy-BakerStreet.ps1` — parameter block and helpers

**Files:**
- Create: `scripts/Deploy-BakerStreet.ps1`

**Step 1: Write the script skeleton with params and helper functions**

```powershell
<#
.SYNOPSIS
    Deploy Baker Street from Windows PowerShell via WSL.

.DESCRIPTION
    Checks prerequisites (WSL2, Docker Desktop, Kubernetes), prompts for
    secrets, then delegates to the existing bash deploy pipeline inside WSL.

.EXAMPLE
    .\Deploy-BakerStreet.ps1
    .\Deploy-BakerStreet.ps1 -SkipSecrets -SkipTelemetry
    .\Deploy-BakerStreet.ps1 -Yes
#>
[CmdletBinding()]
param(
    [switch]$SkipSecrets,
    [switch]$SkipBuild,
    [switch]$SkipImages,
    [switch]$SkipTelemetry,
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
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    )
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
$RepoRoot = Split-Path -Parent $PSScriptRoot
if ($PSScriptRoot -eq (Split-Path -Parent $PSScriptRoot)) {
    # Script is at repo root already (shouldn't happen, but guard)
    $RepoRoot = $PSScriptRoot
}
# More reliable: script is in scripts/, repo root is one level up
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
```

**Step 2: Verify the skeleton parses**

Run: `powershell -NoProfile -Command "& { Get-Help .\scripts\Deploy-BakerStreet.ps1 }"`
Expected: Shows synopsis and parameter list without errors.

**Step 3: Commit**

```bash
git add scripts/Deploy-BakerStreet.ps1
git commit -m "feat: Deploy-BakerStreet.ps1 skeleton with params and helpers"
```

---

### Task 3: Add prerequisite checks (Phase 1)

**Files:**
- Modify: `scripts/Deploy-BakerStreet.ps1` (append after helpers)

**Step 1: Add prerequisite check section**

Append this after the `$RepoRoot` assignment:

```powershell
# ===================================================================
# Phase 1: Prerequisite Checks
# ===================================================================
Write-Banner "Baker Street Deploy (Windows)"

Write-Step "Checking prerequisites..."

# --- WSL2 ---
$wslAvailable = $false
try {
    $wslStatus = wsl --status 2>&1
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
$distros = wsl --list --quiet 2>&1 | Where-Object { $_ -and $_ -notmatch '^\s*$' }
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
Write-Info "Docker Desktop: OK ($(docker --version))"

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
```

**Step 2: Verify prereq checks work**

Run: `powershell -NoProfile -File .\scripts\Deploy-BakerStreet.ps1 -Yes -SkipSecrets -SkipBuild -SkipTelemetry`
Expected: Shows "Baker Street Deploy (Windows)" banner, prereq checks pass (assuming Docker Desktop + K8s are running). Script will error further down since Phase 2-4 aren't implemented yet — that's fine.

**Step 3: Commit**

```bash
git add scripts/Deploy-BakerStreet.ps1
git commit -m "feat: add prerequisite checks with guided fix instructions"
```

---

### Task 4: Add secrets prompting (Phase 2)

**Files:**
- Modify: `scripts/Deploy-BakerStreet.ps1` (append after prereq checks)

**Step 1: Add secrets configuration section**

Append after the Kubernetes check:

```powershell
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
        # Generate 32-byte hex token
        $bytes = New-Object byte[] 32
        ([Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($bytes)
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
    $lines | Set-Content -Path $envFile -Encoding UTF8
    Write-Info "Saved to .env-secrets"

} else {
    Write-Step "Skipping secrets configuration (-SkipSecrets)"
    if (-not $secrets['AUTH_TOKEN']) {
        $bytes = New-Object byte[] 32
        ([Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($bytes)
        $secrets['AUTH_TOKEN'] = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        Add-Content -Path $envFile -Value "AUTH_TOKEN=$($secrets['AUTH_TOKEN'])"
    }
}
```

**Step 2: Verify secrets flow**

Run: `powershell -NoProfile -File .\scripts\Deploy-BakerStreet.ps1 -SkipSecrets -SkipBuild -SkipTelemetry -Yes`
Expected: Shows "Skipping secrets configuration", loads existing .env-secrets without error. Script errors at Phase 4 (not yet written) — expected.

**Step 3: Commit**

```bash
git add scripts/Deploy-BakerStreet.ps1
git commit -m "feat: add native PowerShell secrets prompting"
```

---

### Task 5: Add path conversion and WSL delegation (Phases 3-4)

**Files:**
- Modify: `scripts/Deploy-BakerStreet.ps1` (append after secrets section)

**Step 1: Add WSL delegation section**

Append after the secrets block:

```powershell
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
if ($SkipTelemetry) { $bashArgs += '--skip-telemetry' }
if ($Dev)           { $bashArgs += '--dev' }
if ($Version)       { $bashArgs += '--version'; $bashArgs += $Version }

$bashCmd = "cd '$wslPath' && bash scripts/deploy-all.sh $($bashArgs -join ' ')"

Write-Info "Running: bash scripts/deploy-all.sh $($bashArgs -join ' ')"
Write-Host ""

# Execute in WSL, streaming output in real-time
wsl bash -c $bashCmd

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
```

**Step 2: Full end-to-end test**

Run: `powershell -NoProfile -File .\scripts\Deploy-BakerStreet.ps1 -SkipSecrets -SkipBuild -SkipTelemetry -Yes`
Expected: Prereq checks pass, secrets skipped, path converted, WSL executes deploy-all.sh (which applies k8s manifests), shows final "Ready!" with URL.

**Step 3: Commit**

```bash
git add scripts/Deploy-BakerStreet.ps1
git commit -m "feat: add WSL delegation and final summary"
```

---

### Task 6: Update CLAUDE.md and README with Windows instructions

**Files:**
- Modify: `CLAUDE.md` — add Windows deploy info to Build & Deploy section
- Modify: `README.md` — add Windows section (if it has deploy instructions)

**Step 1: Add Windows section to CLAUDE.md**

In the `## Build & Deploy` section, after the existing bash examples, add:

```markdown
### Windows (PowerShell)

```powershell
# Double-click deploy.bat, or from PowerShell:
.\scripts\Deploy-BakerStreet.ps1

# With options:
.\scripts\Deploy-BakerStreet.ps1 -SkipTelemetry
.\scripts\Deploy-BakerStreet.ps1 -SkipBuild       # skip pnpm + docker builds
.\scripts\Deploy-BakerStreet.ps1 -SkipSecrets      # use existing .env-secrets
.\scripts\Deploy-BakerStreet.ps1 -Yes               # non-interactive
```

Prerequisites: Docker Desktop (with Kubernetes enabled) and WSL2.
```

**Step 2: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: add Windows deploy instructions"
```

---

### Task 7: Final verification

**Step 1: Run the full script from a clean state**

Run: `powershell -NoProfile -File .\scripts\Deploy-BakerStreet.ps1 -SkipTelemetry`
Expected: Full interactive flow — prereq checks, secrets prompting (or skip if .env-secrets exists), WSL build + deploy, final URL shown.

**Step 2: Verify deploy.bat works**

Run: Double-click `scripts\deploy.bat` in File Explorer (or from cmd: `scripts\deploy.bat -SkipSecrets -SkipTelemetry -Yes`)
Expected: Same output as running the .ps1 directly.

**Step 3: Verify .env-secrets was written correctly**

Run: `wsl bash -c "cat .env-secrets"` from the repo root
Expected: Standard `KEY=VALUE` format, readable by bash `source`.
