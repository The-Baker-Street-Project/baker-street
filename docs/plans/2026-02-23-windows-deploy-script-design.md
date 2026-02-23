# Windows Deploy Script Design

## Problem

Less technical users have WSL2 integration but will run setup/deploy from PowerShell. They need a Windows-native entry point that handles prerequisites and secrets UX, then delegates to the existing bash deploy pipeline.

## Decision: Thin WSL Wrapper

Single `Deploy-BakerStreet.ps1` + `deploy.bat` launcher. PowerShell handles prerequisites, secrets prompting, and path conversion. Bash remains the single source of truth for build/deploy logic.

Rejected alternatives:
- **Full native PowerShell rewrite** — duplicates ~760 lines of bash, must be kept in sync
- **Multi-file setup/deploy split** — adds cognitive overhead for target audience
- **Hybrid** — unnecessary complexity; native secrets prompting + WSL delegation covers the need

## Architecture

```
deploy.bat (3-line launcher, bypasses execution policy)
  └── Deploy-BakerStreet.ps1
        ├── Phase 1: Prerequisites (native PS)
        │   ├── WSL2 installed + has a distro?
        │   ├── Docker Desktop running?
        │   ├── Kubernetes enabled in Docker Desktop?
        │   └── Guided fix instructions if missing
        │
        ├── Phase 2: Secrets (native PS)
        │   ├── Load existing .env-secrets
        │   ├── Prompt missing keys (Read-Host -AsSecureString)
        │   ├── Auto-generate AUTH_TOKEN
        │   └── Write .env-secrets
        │
        ├── Phase 3: Path conversion
        │   └── wsl wslpath -u <windows-path>
        │
        └── Phase 4: WSL delegation
            └── wsl bash <path>/scripts/deploy-all.sh --skip-secrets -y [flags]
```

## Files

| File | Purpose |
|------|---------|
| `scripts/Deploy-BakerStreet.ps1` | Main PowerShell script (~200 lines) |
| `scripts/deploy.bat` | Double-click launcher (3 lines) |

## Parameters

```powershell
Deploy-BakerStreet.ps1
  [-SkipSecrets]      # Use existing .env-secrets
  [-SkipBuild]        # Skip pnpm + Docker builds
  [-SkipImages]       # Skip Docker builds only
  [-SkipTelemetry]    # Skip telemetry (default: skip)
  [-Dev]              # Dev overlay
  [-Version <string>] # Custom version tag
  [-Yes]              # Non-interactive
```

Mirrors bash flags exactly.

## Prerequisite Checks

Each check shows specific fix instructions on failure:

1. **WSL2**: `wsl --status` — guide to `wsl --install` if missing
2. **Docker Desktop**: `docker info` — guide to install via `winget install Docker.DockerDesktop`
3. **Kubernetes**: `kubectl cluster-info` — guide to enable in Docker Desktop Settings > Kubernetes

## Secrets UX

- `Read-Host -AsSecureString` for API keys (masked terminal input)
- Color-coded output (Write-Host -ForegroundColor) matching bash style
- Shows `****<last 4>` for already-configured values
- Writes standard `KEY=VALUE` to `.env-secrets` (same format bash reads)
- Skips entirely with `-SkipSecrets` or if `.env-secrets` exists and `-Yes`

## Repo Path Handling

Repo lives on Windows filesystem (e.g. `C:\Users\...\baker-street`). Script converts to WSL path via:

```powershell
$wslPath = (wsl wslpath -u ($repoRoot -replace '\\', '/')).Trim()
```

## Error Handling

- Non-zero WSL exit code: show exit code + troubleshooting tips
- Missing prereqs: show numbered steps to fix, then exit
- Ctrl+C: bash `set -e` handles cleanup in WSL
