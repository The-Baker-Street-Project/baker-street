export interface JobDispatch {
  jobId: string;
  type: 'agent' | 'command' | 'http';
  createdAt: string;
  job?: string;
  command?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  vars?: Record<string, unknown>;
  source?: string;
  /** W3C trace context for distributed tracing */
  traceContext?: Record<string, string>;
}

export interface JobStatus {
  jobId: string;
  workerId: string;
  status: 'received' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  durationMs?: number;
  /** Trace ID for correlating with distributed traces */
  traceId?: string;
}

export interface Heartbeat {
  id: string;
  uptime: number;
  timestamp: string;
}

// --- Brain Transfer Protocol ---

export type BrainState = 'pending' | 'active' | 'draining' | 'shutdown';

export interface TransferReady {
  id: string;
  version: string;
  timestamp: string;
}

export interface TransferClear {
  id: string;
  handoffNoteId: string;
  timestamp: string;
}

export interface TransferAck {
  id: string;
  version: string;
  timestamp: string;
}

export interface TransferAbort {
  id: string;
  reason: string;
  timestamp: string;
}

// --- Task Pod Protocol ---

export interface TaskProgress {
  taskId: string;
  timestamp: string;
  type: 'log' | 'tool_call' | 'thinking' | 'milestone';
  message: string;
  detail?: string;
}

export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'timeout';
  result?: string;
  error?: string;
  durationMs: number;
  filesChanged?: string[];
  traceId?: string;
}

// --- Companions Protocol ---

export interface CompanionAnnounce {
  id: string;
  hostname: string;
  version: string;
  capabilities: string[];
  paths: string[];
  maxConcurrent: number;
  platform: string;
  arch: string;
}

export interface CompanionHeartbeat {
  id: string;
  timestamp: string;
  uptime: number;
  activeTasks: number;
  load: number;
  memoryUsedPct: number;
}

export interface CompanionTask {
  taskId: string;
  mode: 'agent' | 'script';
  goal: string;
  tools?: string[];
  timeout?: number;
  traceParent?: string;
}

export interface CompanionTaskProgress {
  taskId: string;
  companionId: string;
  timestamp: string;
  type: 'log' | 'tool_call' | 'thinking' | 'milestone';
  message: string;
  detail?: string;
}

export interface CompanionTaskResult {
  taskId: string;
  companionId: string;
  status: 'completed' | 'failed' | 'timeout';
  result?: string;
  error?: string;
  durationMs: number;
  traceId?: string;
}
