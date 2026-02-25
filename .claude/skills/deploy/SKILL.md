---
name: deploy
description: Baker Street deployment decision tree. Use when deploying, redeploying, or troubleshooting deployments to the local Kubernetes cluster.
---

# Baker Street Deploy Skill

Guides deployment decisions for Baker Street's Kubernetes-native AI agent system.

## Prerequisites

Before any deploy, verify:
```bash
docker info &>/dev/null && echo "Docker: OK" || echo "Docker: NOT RUNNING"
kubectl cluster-info &>/dev/null 2>&1 && echo "K8s: OK" || echo "K8s: NOT REACHABLE"
kubectl config current-context
```

## Decision Tree

### Q1: What changed?

| What changed | Action |
|---|---|
| **TypeScript code only** (no new deps, no Dockerfile changes) | Quick rebuild: `pnpm -r build && scripts/build.sh && scripts/deploy.sh` |
| **Dependencies** (package.json / pnpm-lock.yaml) | Full rebuild: `scripts/deploy-all.sh --skip-secrets` |
| **Secrets** (.env-secrets) | Secrets only: `scripts/deploy-all.sh --skip-build` |
| **K8s manifests** (k8s/*.yaml) | Apply only: `kubectl apply -k k8s/` (or `k8s/overlays/dev/` for dev) |
| **Dockerfiles** | Rebuild images: `scripts/build.sh && scripts/deploy.sh` |
| **Everything / first time** | Full deploy: `scripts/deploy-all.sh` |
| **Operating system personality** | ConfigMap only: see "Update personality" below |

### Q2: Dev or production mode?

| Mode | How | What it does |
|---|---|---|
| **Dev** | `--dev` flag or `scripts/deploy-all.sh --dev` | Sets `BAKERST_MODE=dev` on all pods, uses `k8s/overlays/dev/` |
| **Production** | Default (no flag) | Uses `k8s/` base kustomization |

### Q3: Optional stacks?

| Stack | Flag to skip | When to include |
|---|---|---|
| **Telemetry** (OTel, Grafana, Tempo, Loki, Prometheus) | `--skip-telemetry` | Debugging perf issues, tracing message flow |
| **Extensions** (example pods) | `--skip-extensions` | Testing extension SDK, tool development |

## Common Deploy Recipes

### Full fresh deploy (interactive)
```bash
scripts/deploy-all.sh
```

### Quick code iteration (non-interactive)
```bash
pnpm -r build && scripts/build.sh && kubectl rollout restart deploy/brain-blue deploy/worker -n bakerst
```

### Update personality files only
```bash
kubectl create configmap bakerst-os --from-file=operating_system/ -n bakerst --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deploy/brain-blue -n bakerst
```

### Rebuild and deploy single service
```bash
# Example: brain only
pnpm -r build
docker build -t bakerst-brain:latest -f services/brain/Dockerfile .
kubectl rollout restart deploy/brain-blue -n bakerst
```

### Non-interactive CI-style deploy
```bash
scripts/deploy-all.sh -y --skip-telemetry --skip-extensions
```

### Redeploy secrets only (after editing .env-secrets)
```bash
scripts/deploy-all.sh --skip-build --skip-telemetry --skip-extensions
```

## Version Tagging

By default, images are tagged with the git short hash. Override with:
```bash
scripts/deploy-all.sh --version v1.2.3
```

## Post-Deploy Verification

After any deploy, verify:
```bash
# All pods running?
kubectl get pods -n bakerst

# Brain API responding?
curl -s http://localhost:30000/ping

# UI accessible?
curl -s -o /dev/null -w "%{http_code}" http://localhost:30080

# Check rollout status
kubectl rollout status deploy/brain-blue deploy/worker deploy/ui deploy/gateway -n bakerst
```

## Access Points

| Service | URL |
|---|---|
| UI | http://localhost:30080 |
| Brain API | http://localhost:30000 |
| Grafana (if telemetry) | http://localhost:30001 |

## Troubleshooting Deploy Failures

If a deploy fails, use the `debug-bakerst` skill for systematic diagnosis.

Common quick fixes:
- **Image pull error**: `scripts/build.sh` (images are local-only, not pushed to registry)
- **Secret missing**: Check `.env-secrets` exists, re-run `scripts/deploy-all.sh --skip-build`
- **Pod OOMKilled**: Check `kubectl describe pod <name> -n bakerst` for resource limits
- **Rollout timeout**: `kubectl rollout status deploy/<name> -n bakerst` then check logs
