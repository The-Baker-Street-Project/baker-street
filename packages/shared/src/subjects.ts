export const Subjects = {
  JOBS_DISPATCH: 'bakerst.jobs.dispatch',
  JOBS_STATUS: 'bakerst.jobs.status',
  HEARTBEAT_BRAIN: 'bakerst.heartbeat.brain',
  HEARTBEAT_WORKER: 'bakerst.heartbeat.worker',

  // Brain transfer protocol
  TRANSFER_READY: 'bakerst.brain.transfer.ready',
  TRANSFER_CLEAR: 'bakerst.brain.transfer.clear',
  TRANSFER_ACK: 'bakerst.brain.transfer.ack',
  TRANSFER_ABORT: 'bakerst.brain.transfer.abort',

  jobStatus(jobId: string): string {
    return `${Subjects.JOBS_STATUS}.${jobId}`;
  },

  workerHeartbeat(workerId: string): string {
    return `${Subjects.HEARTBEAT_WORKER}.${workerId}`;
  },

  // Task pods
  TASK_PROGRESS: 'bakerst.tasks',
  TASK_RESULT: 'bakerst.tasks',

  taskProgress(taskId: string): string {
    return `bakerst.tasks.${taskId}.progress`;
  },

  taskResult(taskId: string): string {
    return `bakerst.tasks.${taskId}.result`;
  },

  // Companions
  COMPANION_ANNOUNCE: 'bakerst.companions.announce',
  COMPANION_HEARTBEAT: 'bakerst.companions',

  companionHeartbeat(id: string): string {
    return `bakerst.companions.${id}.heartbeat`;
  },

  companionTask(id: string): string {
    return `bakerst.companions.${id}.task`;
  },

  companionTaskProgress(id: string): string {
    return `bakerst.companions.${id}.task.progress`;
  },

  companionTaskResult(id: string): string {
    return `bakerst.companions.${id}.task.result`;
  },

  companionCapabilities(id: string): string {
    return `bakerst.companions.${id}.capabilities`;
  },
} as const;

export const JetStream = {
  STREAM_JOBS: 'BAKERST_JOBS',
  CONSUMER_WORKERS: 'JOB_WORKERS',
} as const;
