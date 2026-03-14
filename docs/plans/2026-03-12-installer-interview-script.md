# Installer Interview Script v3

<!-- Implemented: 2026-03-12 | See installer v0.6 -->

## Principles

1. **Validate everything at collect time.** If we can check it, we check it before moving on. No collecting 20 answers to fail at deploy.
2. **Save the user from himself.** Rewrite localhost, recommend models, flag bad keys immediately.
3. **Env vars as defaults.** If we find it in the environment, offer it. One keystroke to accept.
4. **Existing cluster as defaults.** On reinstall/update, read current K8s secrets. User presses Enter through everything.

---

## Opening

```
Baker Street Installer v0.6.0

Let's set up Baker Street!
Press Enter to accept defaults shown in [brackets].
Environment variables are used as defaults when available.
```

---

## Section 1: Basics

```
--- Basics ---

What is the name of the Kubernetes namespace? [bakerst]:

What name would you like to give your AI assistant? [Baker]:
```

---

## Section 2: AI Provider

```
--- AI Provider ---

Which AI provider would you like to use?

  1) Anthropic (Claude — Sonnet, Opus, Haiku)
  2) OpenAI (GPT-4o, o3-mini)
  3) Ollama (local models — OpenAI-compatible API)

Choice [1]:
```

> Single choice for now. Multi-provider support is a future enhancement (BAK-63).

### Model roles explanation (shown after provider selection)

```
Baker Street uses four model roles:

  Agent     — your main conversational AI. Handles chat, tool calling,
              and complex reasoning. Needs the strongest model you have.
              (Claude Sonnet, GPT-4o, Qwen 32B+)

  Worker    — runs background tasks: summarization, extraction, research.
              Optimized for throughput. A fast inference model shines here.
              (Claude Haiku, GPT-4o-mini, Qwen 8B, Llama 8B)

  Observer  — watches every conversation in real-time. Flags tone drift,
              factual errors, and safety issues. Runs on every message,
              so speed matters more than depth.
              Default: same model as Worker.

  Reflector — deep post-conversation analysis. Reviews what went well,
              what didn't, and extracts learnings. Runs infrequently,
              so it can afford a stronger model.
              Default: same model as Agent.
```

### If Anthropic selected

```
Paste your Anthropic API key:
```

> **Validation:** Immediately call the API (e.g. `GET /v1/models` or a minimal
> completion request). If invalid, show error and re-prompt. Do NOT continue
> with a bad key.

```
  ✓ API key verified

Recommended models:

  Agent:     claude-sonnet-4-20250514 (best balance of speed and capability)
  Worker:    claude-haiku-4-5-20251001 (fast and cheap for background tasks)
  Observer:  claude-haiku-4-5-20251001 (same as Worker — fast inline checks)
  Reflector: claude-sonnet-4-20250514 (same as Agent — deep analysis)

What model for the Agent? [claude-sonnet-4-20250514]:
What model for the Worker? [claude-haiku-4-5-20251001]:

Configure Observer and Reflector separately? [y/N]:
```

> If yes, prompt for Observer and Reflector models.
> If no (default), Observer = Worker model, Reflector = Agent model.

```
# Only if they said yes:
What model for the Observer? [claude-haiku-4-5-20251001]:
What model for the Reflector? [claude-sonnet-4-20250514]:
```

### If OpenAI selected

```
Paste your OpenAI API key:
```

> **Validation:** Call OpenAI API to verify key. If invalid, re-prompt.

```
  ✓ API key verified

Recommended models:

  Agent:     gpt-4o (strong tool calling and reasoning)
  Worker:    gpt-4o-mini (fast and cost-effective)
  Observer:  gpt-4o-mini (same as Worker)
  Reflector: gpt-4o (same as Agent)

What model for the Agent? [gpt-4o]:
What model for the Worker? [gpt-4o-mini]:

Configure Observer and Reflector separately? [y/N]:
```

### If Ollama selected

```
Enter your Ollama endpoint(s), comma-separated [localhost:11434]:
  (localhost URLs are automatically rewritten for Kubernetes)
```

> **Validation:** Rewrite localhost → host.docker.internal (for Docker Desktop/
> OrbStack), then HTTP GET each endpoint. If unreachable:

```
  ✗ Could not reach host.docker.internal:8085
    Is your Ollama/MLX server running? Check and try again.

Re-enter endpoint(s), or press Enter to continue anyway [host.docker.internal:8085]:
```

> If reachable, discover models:

```
  ✓ Connected to host.docker.internal:8085

Found 4 models:

  1) qwen2.5-coder:32b (18 GB)
  2) qwen3.5:9b (5.4 GB)
  3) llama3.1:8b (4.7 GB)
  4) granite3-dense:8b (4.9 GB)

Recommended:
  Agent:     qwen2.5-coder:32b (largest — best for reasoning and tool calling)
  Worker:    qwen3.5:9b (good throughput for background tasks)
  Observer:  qwen3.5:9b (same as Worker — fast inline checks)
  Reflector: qwen2.5-coder:32b (same as Agent — deep analysis)

What model for the Agent? [qwen2.5-coder:32b]:
What model for the Worker? [qwen3.5:9b]:

Configure Observer and Reflector separately? [y/N]:
```

> The installer ranks models by parameter count (inferred from size).
> Largest → Agent/Reflector. Smallest viable (>= 7B) → Worker/Observer.
> User can override any choice.

```
# If discovery fails entirely:

  ✗ Could not discover models from endpoint(s).
    You can still enter model names manually.

What model for the Agent?:
What model for the Worker?:

Configure Observer and Reflector separately? [y/N]:
```

> **Validation after model entry:** If Ollama, verify the model exists on the
> endpoint (`GET /api/show`). If not found, warn and ask to re-enter.

```
  ✗ Model "qwen3:70b" not found on host.docker.internal:8085.
    Available: qwen2.5-coder:32b, qwen3.5:9b, llama3.1:8b, granite3-dense:8b

What model for the Agent? [qwen2.5-coder:32b]:
```

---

## Section 3: Security

```
--- Security ---

Enter an auth token, or press Enter to generate one automatically. [auto]:
```

> Token is shown and copied to clipboard at the end of install (Section 7).

---

## Section 4: Memory & Embeddings

```
--- Memory & Embeddings ---

Baker Street stores conversation memories as vector embeddings.
Better embeddings = better recall. Voyage AI provides high-quality
embeddings, but memory still works without it (just less precise).

Paste your Voyage AI API key, or press Enter to skip: [skip]
```

> **Validation:** If key entered, verify against Voyage API. If invalid, re-prompt.

> If they enter a key, the `voyage` feature is auto-enabled. No separate toggle.

---

## Section 5: Features

Each feature follows the same pattern:
1. Ask if they want it
2. If env var exists → "I found X, use this? [Y/n]"
3. If no env var or they decline → ask them to paste it
4. **Validate** the key/token/URL immediately
5. Ask any secondary config questions

```
--- Features ---
```

### Telegram

```
Would you like to communicate through Telegram? [y/N]:
```

If yes + env var found:

```
I found a Telegram bot token in your environment [8530...5r8A].
Use this token? [Y/n]:
```

If declined or no env var:

```
Paste your Telegram bot token (from @BotFather):
```

> **Validation:** Call Telegram `getMe` API with the token. If invalid:
> ```
>   ✗ Invalid bot token. Check with @BotFather and try again.
> Paste your Telegram bot token:
> ```

```
  ✓ Bot verified: @YourBotName

Restrict to specific chat IDs?
Enter comma-separated IDs to restrict, or press Enter to allow all chats. [all]:
```

### Discord

```
Would you like to communicate through Discord? [y/N]:
```

If yes + env var found:

```
I found a Discord bot token in your environment [MTE2...abc].
Use this token? [Y/n]:
```

If declined or no env var:

```
Paste your Discord bot token (from Discord Developer Portal):
```

> **Validation:** Call Discord API to verify token.

### GitHub

```
Would you like your agent to browse repos, issues, and PRs? [y/N]:
```

If yes + env var found:

```
I found a GitHub token in your environment [ghp_...Q4Tq].
Use this token? [Y/n]:
```

If declined or no env var:

```
Paste your GitHub personal access token (from github.com/settings/tokens):
```

> **Validation:** Call GitHub API (`GET /user`) with the token. If invalid, re-prompt.
> If valid, show the authenticated user:
> ```
>   ✓ Authenticated as @garydavidson
> ```

### Perplexity (Web Search)

```
Would you like your agent to search the web? [y/N]:
```

If yes + env var found:

```
I found a Perplexity API key in your environment [pplx...wUxf].
Use this key? [Y/n]:
```

If declined or no env var:

```
Paste your Perplexity API key (from perplexity.ai/settings/api):
```

> **Validation:** Verify key against Perplexity API.

### Obsidian

```
Would you like to connect your Obsidian knowledge vault? [y/N]:
```

If yes:

```
Where's your Obsidian vault? (full path to the folder) [/data/obsidian]:
```

> **Validation:** Check the path exists and contains an `.obsidian` folder.
> If not found:
> ```
>   ✗ No Obsidian vault found at /data/obsidian
>     (looking for .obsidian/ folder)
> Enter the path to your vault:
> ```

### Voice

```
Would you like to speak with your agent in a conversational style? [y/N]:
```

If yes:

```
Voice mode needs a Speech-to-Text (STT) and Text-to-Speech (TTS) service.

STT service URL (e.g. http://localhost:8083):
```

> **Validation:** Rewrite localhost, then check endpoint is reachable.

```
  ✓ STT service reachable at host.docker.internal:8083

STT API key (if required, or press Enter to skip): [skip]

TTS service URL (e.g. http://localhost:8084):
```

> **Validation:** Same — rewrite localhost, check reachable.

```
TTS API key (if required, or press Enter to skip): [skip]
```

### Google Workspace

```
Would you like your agent to access Gmail, Calendar, and Google Drive? [y/N]:
```

If yes + env var found:

```
I found a Google OAuth Client ID in your environment [9968...0k1l].
Use this? [Y/n]:
```

If declined or no env var:

```
Paste your Google OAuth Client ID (from console.cloud.google.com):
```

```
Paste the OAuth Client Secret:
```

> Account selection happens in the browser during the OAuth flow after install.
> No email question needed.

---

## Section 6: Confirmation

```
--- Review ---

  Namespace:    bakerst
  Agent name:   Irene

  Provider:     Ollama (host.docker.internal:8085)
  Agent model:  qwen2.5-coder:32b
  Worker model: qwen3.5:9b
  Observer:     qwen3.5:9b (same as Worker)
  Reflector:    qwen2.5-coder:32b (same as Agent)

  Features:     Telegram, GitHub, Perplexity, Obsidian, Google Workspace
  Memory:       Voyage AI embeddings

  All checks passed ✓

Proceed with installation? [Y/n]:
```

> On update/reinstall, the installer checks for an existing `bakerst` namespace
> and reads current K8s secrets as defaults — no config file needed. Non-technical
> users just re-run the installer and press Enter through everything.

---

## Section 7: Post-Install

```
# After install completes:

Configuration saved to ~/.bakerst/config.json
  (feature selections and non-sensitive values only — no secrets)

Auth token copied to clipboard!
You'll need this to log in at http://localhost:30080
Token: 796c654e16b0215ba2168bdb7d7219a528111a2fed5ea48e9c17e5a880f69b9c

Installation complete!
  Access Baker Street at http://localhost:30080
```

---

## Validation Summary

Every input that can be verified IS verified before moving on:

| Input | Validation | On Failure |
|-------|-----------|------------|
| Anthropic API key | Call API | Re-prompt |
| OpenAI API key | Call API | Re-prompt |
| Ollama endpoint | HTTP GET | Warn, offer re-enter or continue |
| Ollama model name | `GET /api/show` | Show available models, re-prompt |
| Voyage AI key | Call API | Re-prompt |
| Telegram bot token | `getMe` API | Re-prompt |
| Discord bot token | Call API | Re-prompt |
| GitHub token | `GET /user` | Re-prompt |
| Perplexity key | Call API | Re-prompt |
| Obsidian vault path | Check `.obsidian/` exists | Re-prompt |
| STT/TTS service URL | HTTP GET (after localhost rewrite) | Warn, offer re-enter |
| localhost in URLs | Auto-rewrite to `host.docker.internal` | Automatic, tell user |

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Provider selection | Single choice (for now) | Simpler UX, covers 90% of users. Multi-provider is BAK-63. |
| Model roles | 4 roles (Agent, Worker, Observer, Reflector) | Agent+Worker always asked. Observer+Reflector default to Worker/Agent, optional override. |
| Model selection | Auto-recommend from discovery | Ollama: discover + rank by size. Cloud: hardcoded best defaults. |
| Observer default | Same as Worker model | Fast, runs on every message. User can override. |
| Reflector default | Same as Agent model | Needs reasoning, runs infrequently. User can override. |
| API key for selected provider | Required | They chose it — they need a key. No "skip". |
| Validation | Immediate, at collect time | Never proceed with a bad key/endpoint/path. Save the user from himself. |
| Ollama endpoint validation | Validate + discover models | Try to reach endpoint, list models, recommend by size. |
| localhost rewriting | Automatic + tell user | Rewrite silently, but note it so they understand. |
| Telegram chat IDs | Default "all" | Less confusing. Security-conscious users can restrict. |
| Auth token | Clipboard + display at end | User needs it for first login. Don't bury it. |
| Secrets storage | Never saved to disk | Retrieved from existing K8s cluster on update/reinstall. |
| Google email | Not asked | Handled during OAuth flow in browser after install. |
| Backup path | Dropped for now | Backups feature not yet implemented. Add when ready. |
| Voice | Ask for URLs first, keys optional | Addresses BAK-60. STT/TTS are services, not just API keys. |

## Testing Strategy

Every installer change is validated against scenario answer files before release.
Scenarios live in `test/installer-scenarios/` and are gitignored (may contain real API keys for local testing).

### Answer File Format

Answer files are YAML configs passed via `bakerst-install install --config <file>`.
They use `${ENV_VAR}` interpolation and `auto` for token generation.
See `test/installer-scenarios/README.md` for the full template.

### Scenarios

| Scenario | Provider | Agent | Worker | Why |
|----------|----------|-------|--------|-----|
| `anthropic-cloud` | Anthropic | sonnet 4 | haiku 4.5 | Baseline cloud path |
| `openai-cloud` | OpenAI | gpt-4o | gpt-4o-mini | OpenAI provider path |
| `ollama-single` | Ollama (1 endpoint) | qwen2.5-coder:32b | qwen3.5:9b | Local-only install |
| `ollama-multi` | Ollama (2 endpoints) | qwen2.5-coder:32b | qwen3.5:9b | Multi-host inference |
| `anthropic-voyage` | Anthropic + Voyage | sonnet 4 | haiku 4.5 | Enhanced embeddings |
| `dual-provider` | Anthropic + Ollama | sonnet 4 | qwen3.5:9b | Cloud agent + local worker |

### What Each Scenario Validates

1. Installer exits 0 (install completes)
2. All expected pods are Running (brain-blue, worker, ui, gateway, nats, qdrant)
3. Brain `/ping` responds OK
4. NATS health check passes
5. Test prompt gets a response (end-to-end AI round trip)
6. Correct `DEFAULT_MODEL` and `WORKER_MODEL` on brain pod
7. UI serves on NodePort 30080
8. Gateway is ready
9. Qdrant is healthy
10. `OLLAMA_ENDPOINTS` does NOT contain `localhost` (K8s can't reach host that way)

### Running

```bash
# All scenarios against latest GHCR release:
cd test/installer-scenarios && ./run-scenarios.sh

# One scenario:
./run-scenarios.sh scenario-anthropic-cloud.yaml

# Pinned version:
./run-scenarios.sh --version 0.6.0

# Local binary (skip download):
./run-scenarios.sh --binary ../../tools/installer/target/release/bakerst-install
```

Each scenario: install → verify → extra checks → delete namespace → next.
Results saved to `test/installer-scenarios/results-<timestamp>/`.

### Rules

- **GHCR images only.** No `--template` with local images. As close to the real user experience as possible.
- **No external features.** Telegram, Discord, GitHub, Google Workspace are not tested — they require real bot tokens and external services.
- **Clean namespace per scenario.** Delete namespace before and after each run.
- **New scenarios for new features.** When Observer/Reflector models are implemented, add scenarios that validate the correct model is set for each role.

---

## Future Enhancements

- **Multi-provider support** — select multiple providers, assign per role (e.g. Ollama for Agent, Anthropic for Observer)
- **TUI with checkbox selection** — richer terminal UI (ratatui/crossterm)
- **Admin config screen** — edit all values from the web UI (BAK-61)
- **Model discovery for cloud providers** — list available models from API
- **Third Ollama endpoint** — for users with 3+ inference hosts
