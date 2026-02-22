import * as k8s from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';
import { logger, Subjects, codec, type TaskProgress, type TaskResult } from '@bakerst/shared';
import type { NatsConnection, Subscription } from 'nats';
import { insertTaskPod, updateTaskPod, getTaskPod, listTaskPods, type TaskPodRow } from './db.js';

const log = logger.child({ module: 'task-pod-manager' });

const NAMESPACE = 'bakerst';
const ALLOWED_PATHS = (process.env.TASK_ALLOWED_PATHS ?? '').split(',').filter(Boolean);
const DEFAULT_TIMEOUT = 1800; // 30 minutes
const TTL_AFTER_FINISHED = 300; // 5 minutes

export interface TaskPodRequest {
  recipe?: string;
  toolbox: string;
  mode: 'agent' | 'script';
  goal: string;
  mounts?: Array<{
    hostPath: string;
    permissions: ('read' | 'write' | 'delete')[];
  }>;
  secrets?: string[];
  timeout?: number;
}

export class TaskPodManager {
  private batchApi: k8s.BatchV1Api;
  private coreApi: k8s.CoreV1Api;
  private nc: NatsConnection;
  private subscriptions: Map<string, Subscription> = new Map();

  constructor(nc: NatsConnection) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.nc = nc;
    log.info('TaskPodManager initialized');
  }

  async dispatch(req: TaskPodRequest): Promise<string> {
    const taskId = randomUUID();
    const jobName = `bakerst-task-${taskId.slice(0, 8)}`;

    // Validate mounts against allowlist
    // When TASK_ALLOWED_PATHS is not configured, deny all mounts
    if (req.mounts?.length) {
      if (ALLOWED_PATHS.length === 0) {
        throw new Error('Mount paths are not allowed: TASK_ALLOWED_PATHS is not configured');
      }
      for (const mount of req.mounts) {
        const allowed = ALLOWED_PATHS.some((p) => mount.hostPath.startsWith(p));
        if (!allowed) {
          throw new Error(`Mount path not allowed: ${mount.hostPath}. Allowed: ${ALLOWED_PATHS.join(', ')}`);
        }
      }
    }

    // Build volume mounts and volumes from mount specs
    const volumeMounts: k8s.V1VolumeMount[] = [
      { name: 'tmp', mountPath: '/tmp' },
    ];
    const volumes: k8s.V1Volume[] = [
      { name: 'tmp', emptyDir: {} },
    ];

    if (req.mounts) {
      req.mounts.forEach((mount, i) => {
        const volName = `mount-${i}`;
        const readOnly = !mount.permissions.includes('write') && !mount.permissions.includes('delete');
        volumeMounts.push({
          name: volName,
          mountPath: `/workspace/mount-${i}`,
          readOnly,
        });
        volumes.push({
          name: volName,
          hostPath: { path: mount.hostPath, type: 'Directory' },
        });
      });
    }

    // Build Job manifest
    const job: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: NAMESPACE,
        labels: {
          app: 'bakerst-task',
          'task-id': taskId,
          toolbox: req.toolbox,
        },
      },
      spec: {
        ttlSecondsAfterFinished: TTL_AFTER_FINISHED,
        activeDeadlineSeconds: req.timeout ?? DEFAULT_TIMEOUT,
        backoffLimit: 0,
        template: {
          spec: {
            serviceAccountName: 'bakerst-task',
            restartPolicy: 'Never',
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [{
              name: 'task-runner',
              image: `bakerst-task-runner:${req.toolbox}`,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              env: [
                { name: 'TASK_ID', value: taskId },
                { name: 'TASK_MODE', value: req.mode },
                { name: 'TASK_GOAL', value: req.goal },
                { name: 'NATS_URL', value: 'nats://nats.bakerst.svc:4222' },
              ],
              volumeMounts,
              resources: {
                requests: { memory: '128Mi', cpu: '100m' },
                limits: { memory: '512Mi', cpu: '500m' },
              },
            }],
            volumes,
          },
        },
      },
    };

    // Persist to DB
    insertTaskPod({
      taskId,
      recipeId: req.recipe,
      toolbox: req.toolbox,
      mode: req.mode,
      goal: req.goal,
      mounts: req.mounts ? JSON.stringify(req.mounts) : undefined,
      jobName,
    });

    // Create K8s Job
    try {
      await this.batchApi.createNamespacedJob({ namespace: NAMESPACE, body: job });
      updateTaskPod(taskId, { status: 'running' });
      log.info({ taskId, jobName, toolbox: req.toolbox, mode: req.mode }, 'task pod dispatched');
    } catch (err) {
      updateTaskPod(taskId, { status: 'failed', error: String(err) });
      log.error({ err, taskId }, 'failed to create K8s Job');
      throw err;
    }

    // Subscribe to result
    this.subscribeToResult(taskId);

    return taskId;
  }

  private subscribeToResult(taskId: string): void {
    const sub = this.nc.subscribe(Subjects.taskResult(taskId));
    this.subscriptions.set(taskId, sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const result = codec.decode(msg.data) as TaskResult;
          updateTaskPod(taskId, {
            status: result.status,
            result: result.result,
            error: result.error,
            durationMs: result.durationMs,
            filesChanged: result.filesChanged ? JSON.stringify(result.filesChanged) : undefined,
            traceId: result.traceId,
          });
          log.info({ taskId, status: result.status }, 'task pod completed');
        } catch (err) {
          log.error({ err, taskId }, 'failed to process task result');
        }
        sub.unsubscribe();
        this.subscriptions.delete(taskId);
      }
    })();
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = getTaskPod(taskId);
    if (!task?.job_name) return false;

    try {
      await this.batchApi.deleteNamespacedJob({
        name: task.job_name,
        namespace: NAMESPACE,
        body: { propagationPolicy: 'Background' },
      });
      updateTaskPod(taskId, { status: 'failed', error: 'Cancelled by user' });
      // Clean up NATS subscription if still active
      const sub = this.subscriptions.get(taskId);
      if (sub) {
        sub.unsubscribe();
        this.subscriptions.delete(taskId);
      }
      log.info({ taskId }, 'task pod cancelled');
      return true;
    } catch (err) {
      log.error({ err, taskId }, 'failed to cancel task pod');
      return false;
    }
  }

  getTask(taskId: string): TaskPodRow | undefined {
    return getTaskPod(taskId);
  }

  listTasks(limit?: number): TaskPodRow[] {
    return listTaskPods(limit);
  }

  shutdown(): void {
    for (const sub of this.subscriptions.values()) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();
    log.info('TaskPodManager shut down');
  }
}
