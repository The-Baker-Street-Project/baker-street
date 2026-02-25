---
name: debug-bakerst
description: Baker Street Kubernetes debugging runbook. Use when pods crash, messages aren't flowing, extensions fail to register, or any runtime issue in the bakerst namespace.
---

# Baker Street Debugging Skill

Systematic debugging for the Baker Street Kubernetes-native AI agent system.

## Architecture Quick Reference

```
User → UI (port 30080) → Brain API (port 30000)
                              ↓ auth (Bearer AUTH_TOKEN)
                          Brain pod
                              ↓ NATS (bakerst.jobs.dispatch)
                          Worker pod(s)
                              ↓ NATS (bakerst.extensions.announce)
                          Extension pod(s) ← MCP HTTP
```

- **Namespace**: `bakerst` (app), `bakerst-telemetry` (optional observability)
- **Messaging**: NATS JetStream — stream `BAKERST_JOBS`, consumer `JOB_WORKERS`
- **Key subjects**: See `packages/shared/src/subjects.ts`

## Step 1: Cluster Health Check

Run these first to get a snapshot:

```bash
# Pod status — are all pods Running?
kubectl get pods -n bakerst -o wide

# Recent events — look for scheduling, image pull, or OOM issues
kubectl get events -n bakerst --sort-by=.lastTimestamp | tail -20

# Resource pressure
kubectl top pods -n bakerst 2>/dev/null || echo "metrics-server not installed"
```

**What to look for:**
- `CrashLoopBackOff` → go to Step 3 (pod logs)
- `ImagePullBackOff` → image not built locally, run `scripts/build.sh`
- `Pending` → check node resources or PVC issues
- `0/1 Ready` → readiness probe failing, check health endpoints

## Step 2: Service Connectivity

```bash
# Verify services exist and have endpoints
kubectl get svc -n bakerst
kubectl get endpoints -n bakerst

# Check NATS is reachable from brain
kubectl exec -n bakerst deploy/brain-blue -- sh -c 'nc -zv nats 4222 2>&1' || echo "NATS unreachable from brain"

# Check brain API responds
kubectl exec -n bakerst deploy/ui -- sh -c 'wget -qO- http://brain:3000/ping 2>&1' || echo "Brain API unreachable from UI"
```

## Step 3: Pod Logs (follow the message flow)

Check in order — upstream to downstream:

```bash
# 1. NATS — is the message broker healthy?
kubectl logs -n bakerst deploy/nats --tail=50

# 2. Brain — is it receiving requests and dispatching jobs?
kubectl logs -n bakerst deploy/brain-blue --tail=100

# 3. Worker — is it picking up jobs from NATS?
kubectl logs -n bakerst deploy/worker --tail=100

# 4. Gateway — is it forwarding messages (Telegram/Discord)?
kubectl logs -n bakerst deploy/gateway --tail=50

# 5. Extensions — are they announcing and responding?
for pod in $(kubectl get pods -n bakerst -l app=extension -o name 2>/dev/null); do
  echo "--- $pod ---"
  kubectl logs -n bakerst "$pod" --tail=30
done
```

## Step 4: Common Failure Patterns

### Secret Misconfiguration
```bash
# Verify secrets exist and have expected keys
kubectl get secret bakerst-brain-secrets -n bakerst -o json | jq '.data | keys'
kubectl get secret bakerst-worker-secrets -n bakerst -o json | jq '.data | keys'
kubectl get secret bakerst-gateway-secrets -n bakerst -o json | jq '.data | keys'
```
- Missing `ANTHROPIC_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` → brain/worker can't call Claude
- Missing `AUTH_TOKEN` → gateway can't authenticate to brain
- Fix: re-run `scripts/deploy-all.sh` or `scripts/secrets.sh`

### NATS Connection Refused
```bash
kubectl logs -n bakerst deploy/nats --tail=20
kubectl describe pod -n bakerst -l app=nats
```
- NATS pod not ready → check resource limits, PVC issues
- Brain/worker log `NATS connection refused` → NATS service DNS not resolving, check `kubectl get svc nats -n bakerst`

### Extension Not Discovered
```bash
# Check if extension announced on NATS
kubectl logs -n bakerst deploy/brain-blue --tail=200 | grep -i "extension\|announce\|discover"

# Check extension pod logs for announce errors
kubectl logs -n bakerst -l app=extension --tail=50
```
- Extension must publish to `bakerst.extensions.announce`
- Brain must be listening — check brain startup logs for "extension discovery"
- Network policy may block: check `k8s/network-policies.yaml`

### Brain API 401/403
- UI shows "Unauthorized" → AUTH_TOKEN mismatch between brain secret and what UI/gateway sends
- Check: `kubectl get secret bakerst-brain-secrets -n bakerst -o jsonpath='{.data.AUTH_TOKEN}' | base64 -d`
- Compare with gateway secret: `kubectl get secret bakerst-gateway-secrets -n bakerst -o jsonpath='{.data.AUTH_TOKEN}' | base64 -d`

### Blue/Green Deploy Stuck
```bash
# Check which deployment is active
kubectl get deploy -n bakerst -l app=brain
kubectl get svc brain -n bakerst -o jsonpath='{.spec.selector}'
```
- Service selector may point to wrong color
- Transfer protocol subjects: `bakerst.brain.transfer.*`

## Step 5: Telemetry (if deployed)

```bash
kubectl get pods -n bakerst-telemetry
kubectl logs -n bakerst-telemetry deploy/otel-collector --tail=30
kubectl logs -n bakerst-telemetry deploy/grafana --tail=30
```
- Grafana: http://localhost:30001
- If no traces/metrics: check OTel collector → are app pods sending OTLP to `otel-collector.bakerst-telemetry.svc.cluster.local:4318`?

## Step 6: Nuclear Options (confirm with user first)

```bash
# Restart a specific deployment
kubectl rollout restart deploy/<name> -n bakerst

# Delete and re-apply all manifests
kubectl delete -k k8s/ && kubectl apply -k k8s/

# Full redeploy
scripts/deploy-all.sh --skip-secrets
```

## Reporting

After debugging, summarize:
1. **Symptom**: What the user reported
2. **Root cause**: What was actually wrong
3. **Fix applied**: What you did
4. **Prevention**: How to avoid this in the future (consider updating CLAUDE.md or memory)
