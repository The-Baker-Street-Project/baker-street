import * as k8s from '@kubernetes/client-node';
import { logger } from '@bakerst/shared';
import type { RegisteredTool } from '../types.js';

const log = logger.child({ module: 'k8s-health' });

const NAMESPACE = process.env.NAMESPACE ?? 'bakerst';

let appsApi: k8s.AppsV1Api;
let coreApi: k8s.CoreV1Api;

function getAppsApi(): k8s.AppsV1Api {
  if (!appsApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    appsApi = kc.makeApiClient(k8s.AppsV1Api);
  }
  return appsApi;
}

function getCoreApi(): k8s.CoreV1Api {
  if (!coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return coreApi;
}

export function createK8sHealthTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'check_pod_health',
        description: 'Check the health of pods matching a label selector. Returns pod status, ready conditions, and restart counts.',
        input_schema: {
          type: 'object',
          properties: {
            labelSelector: { type: 'string', description: 'Label selector (e.g., "app=brain")' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['labelSelector'],
        },
      },
      handler: async (input) => {
        const ns = (input.namespace as string) ?? NAMESPACE;
        const labelSelector = input.labelSelector as string;

        const resp = await getCoreApi().listNamespacedPod({ namespace: ns, labelSelector });
        const pods = resp.items;

        if (pods.length === 0) {
          return { result: `No pods found matching "${labelSelector}" in namespace "${ns}".` };
        }

        const summary = pods.map((pod) => {
          const name = pod.metadata?.name ?? 'unknown';
          const phase = pod.status?.phase ?? 'Unknown';
          const conditions = pod.status?.conditions ?? [];
          const ready = conditions.find((c) => c.type === 'Ready');
          const containers = pod.status?.containerStatuses ?? [];
          const restarts = containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
          const images = containers.map((c) => c.image).join(', ');

          return {
            name,
            phase,
            ready: ready?.status === 'True',
            restarts,
            images,
          };
        });

        return { result: JSON.stringify(summary, null, 2) };
      },
    },
    {
      definition: {
        name: 'get_pod_logs',
        description: 'Get recent logs from a pod.',
        input_schema: {
          type: 'object',
          properties: {
            podName: { type: 'string', description: 'Pod name' },
            container: { type: 'string', description: 'Container name (optional, for multi-container pods)' },
            tailLines: { type: 'number', description: 'Number of lines from the end (default: 50)' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['podName'],
        },
      },
      handler: async (input) => {
        const ns = (input.namespace as string) ?? NAMESPACE;
        const podName = input.podName as string;
        const container = input.container as string | undefined;
        const tailLines = (input.tailLines as number) ?? 50;

        try {
          const resp = await getCoreApi().readNamespacedPodLog({
            name: podName,
            namespace: ns,
            container,
            tailLines,
          });
          return { result: typeof resp === 'string' ? resp : String(resp) };
        } catch (err) {
          return { result: `Failed to get logs: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      definition: {
        name: 'wait_for_rollout',
        description: 'Wait for a Deployment rollout to complete. Polls until all replicas are ready or timeout.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Deployment name' },
            timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default: 120)' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;
        const timeout = ((input.timeoutSeconds as number) ?? 120) * 1000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
          try {
            const dep = await getAppsApi().readNamespacedDeployment({ name, namespace: ns });
            const desired = dep.spec?.replicas ?? 1;
            const ready = dep.status?.readyReplicas ?? 0;
            const updated = dep.status?.updatedReplicas ?? 0;

            if (ready >= desired && updated >= desired) {
              return { result: `Deployment "${name}" rollout complete (${ready}/${desired} ready).` };
            }

            log.debug({ name, ready, desired, updated }, 'waiting for rollout');
          } catch (err) {
            log.warn({ err, name }, 'error checking rollout status');
          }

          await new Promise((r) => setTimeout(r, 3000));
        }

        return { result: `Timeout waiting for deployment "${name}" rollout.` };
      },
    },
    {
      definition: {
        name: 'get_cluster_status',
        description: 'Get an overview of all deployments and pods in the namespace.',
        input_schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
        },
      },
      handler: async (input) => {
        const ns = (input.namespace as string) ?? NAMESPACE;

        const [deployments, pods] = await Promise.all([
          getAppsApi().listNamespacedDeployment({ namespace: ns }),
          getCoreApi().listNamespacedPod({ namespace: ns }),
        ]);

        const depSummary = deployments.items.map((d) => ({
          name: d.metadata?.name,
          replicas: d.spec?.replicas ?? 0,
          ready: d.status?.readyReplicas ?? 0,
          updated: d.status?.updatedReplicas ?? 0,
          available: d.status?.availableReplicas ?? 0,
        }));

        const podSummary = pods.items.map((p) => ({
          name: p.metadata?.name,
          phase: p.status?.phase,
          restarts: (p.status?.containerStatuses ?? []).reduce(
            (sum, c) => sum + (c.restartCount ?? 0),
            0,
          ),
        }));

        return {
          result: JSON.stringify({ deployments: depSummary, pods: podSummary }, null, 2),
        };
      },
    },
  ];
}
