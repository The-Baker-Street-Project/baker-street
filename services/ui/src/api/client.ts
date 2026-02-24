import type { Conversation, Message, ChatResponse, JobStatus, MemoryEntry, SecretEntry, SecretsUpdateResponse, RestartResponse, Skill, SkillDetail, SkillTool, Model, ModelConfig, SystemHealth, SkillStatus, RegistrySearchResult, Schedule, PingResponse, Toolbox, VoiceProviderConfig } from './types';
import { TOKEN_KEY } from './constants';

const BASE = '/api';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = { ...authHeaders(), ...(init?.headers ?? {}) };
  const res = await fetch(`${BASE}${url}`, { ...init, headers });

  if (res.status === 401) {
    // Dispatch event so useAuth can auto-logout
    window.dispatchEvent(new CustomEvent('bakerst:unauthorized', { detail: { status: 401 } }));
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export function getPing(): Promise<PingResponse> {
  // Ping is unauthenticated — use raw fetch, not json() helper
  return fetch(`${BASE}/ping`).then(r => r.json() as Promise<PingResponse>);
}

export function getConversations(): Promise<Conversation[]> {
  return json('/conversations');
}

export function getConversationMessages(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
  return json(`/conversations/${id}/messages`);
}

export function sendChat(message: string, conversationId?: string): Promise<ChatResponse> {
  return json('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId }),
  });
}

export function getJobs(): Promise<JobStatus[]> {
  return json('/jobs');
}

export function getJobStatus(id: string): Promise<JobStatus> {
  return json(`/jobs/${id}/status`);
}

export function searchMemories(query: string, limit = 10): Promise<MemoryEntry[]> {
  return json(`/memories?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export function listMemories(category?: string, limit = 50): Promise<MemoryEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (category) params.set('category', category);
  return json(`/memories?${params}`);
}

export function getSecrets(): Promise<SecretEntry[]> {
  return json('/secrets');
}

export function updateSecrets(secrets: Record<string, string>): Promise<SecretsUpdateResponse> {
  return json('/secrets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secrets }),
  });
}

export function restartServices(): Promise<RestartResponse> {
  return json('/secrets/restart', { method: 'POST' });
}

// --- Skills ---

export function getSkills(): Promise<Skill[]> {
  return json('/skills');
}

export function getSkillDetail(id: string): Promise<SkillDetail> {
  return json(`/skills/${id}`);
}

export function createSkill(skill: Partial<Skill>): Promise<Skill> {
  return json('/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skill),
  });
}

export function updateSkill(id: string, updates: Partial<Skill>): Promise<Skill> {
  return json(`/skills/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export function deleteSkill(id: string): Promise<{ ok: boolean }> {
  return json(`/skills/${id}`, { method: 'DELETE' });
}

export function testSkillConnection(id: string): Promise<{ tools: SkillTool[] }> {
  return json(`/skills/${id}/test`, { method: 'POST' });
}

// --- MCP Registry ---

export function searchRegistry(query: string): Promise<RegistrySearchResult> {
  return json(`/mcps/registry?search=${encodeURIComponent(query)}`);
}

// --- Models ---

export function getModels(): Promise<Model[]> {
  return json('/models');
}

export function getModelConfig(): Promise<ModelConfig> {
  return json('/models/config');
}

export function updateModelConfig(updates: { roles?: Record<string, string>; fallbackChain?: string[] }): Promise<{ ok: boolean }> {
  return json('/models/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

// --- System ---

export function getSystemHealth(): Promise<SystemHealth> {
  return json('/system/health');
}

export function getSkillsStatus(): Promise<SkillStatus[]> {
  return json('/system/skills/status');
}

// --- Schedules ---

export function getSchedules(): Promise<Schedule[]> {
  return json('/schedules');
}

export function createSchedule(params: {
  name: string;
  schedule: string;
  type: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<Schedule> {
  return json('/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function updateSchedule(id: string, updates: Partial<{
  name: string;
  schedule: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
}>): Promise<Schedule> {
  return json(`/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export function deleteScheduleApi(id: string): Promise<{ ok: boolean }> {
  return json(`/schedules/${id}`, { method: 'DELETE' });
}

export function triggerSchedule(id: string): Promise<{ ok: boolean; jobId: string }> {
  return json(`/schedules/${id}/run`, { method: 'POST' });
}

// --- Toolboxes ---

export function getToolboxes(): Promise<Toolbox[]> {
  return json('/toolboxes');
}

export function buildToolbox(name: string): Promise<{ status: string }> {
  return json(`/toolboxes/${name}/build`, { method: 'POST' });
}

export function getToolboxStatus(name: string): Promise<{ status: string }> {
  return json(`/toolboxes/${name}/status`);
}

// --- Voice Config ---

export function getVoiceConfig(): Promise<VoiceProviderConfig> {
  return json('/voice-config');
}

export function updateVoiceConfig(updates: VoiceProviderConfig): Promise<{ ok: boolean }> {
  return json('/voice-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

// --- Skill upload ---

export async function uploadSkillZip(file: File): Promise<Skill> {
  const formData = new FormData();
  formData.append('file', file);
  const headers = authHeaders();
  const res = await fetch(`${BASE}/skills/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('bakerst:unauthorized', { detail: { status: 401 } }));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed: ${body}`);
  }
  return res.json() as Promise<Skill>;
}
