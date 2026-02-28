import * as k8s from '@kubernetes/client-node';
import { logger } from '@bakerst/shared';
import type { SysAdminPersistedState } from '@bakerst/shared';

const log = logger.child({ module: 'persistence' });

const NAMESPACE = process.env.NAMESPACE ?? 'bakerst';
const CONFIGMAP_NAME = 'bakerst-sysadmin-state';
const STATE_KEY = 'state.json';
const RUNTIME_PROMPT_KEY = 'runtime-prompt.md';
const MAX_HEALTH_HISTORY = 100;

let coreApi: k8s.CoreV1Api;

function getApi(): k8s.CoreV1Api {
  if (!coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return coreApi;
}

function defaultState(): SysAdminPersistedState {
  return {
    state: 'deploy',
    healthHistory: [],
  };
}

/**
 * Load persisted state from the ConfigMap. Returns default state if not found.
 */
export async function loadState(): Promise<SysAdminPersistedState> {
  try {
    const resp = await getApi().readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE });
    const raw = resp.data?.[STATE_KEY];
    if (raw) {
      return JSON.parse(raw) as SysAdminPersistedState;
    }
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number } }).response?.statusCode;
    if (status === 404) {
      log.info('state ConfigMap not found, using defaults');
    } else {
      log.warn({ err }, 'failed to read state ConfigMap');
    }
  }
  return defaultState();
}

/**
 * Save persisted state to the ConfigMap. Creates if not exists.
 */
export async function saveState(state: SysAdminPersistedState): Promise<void> {
  // Trim health history
  if (state.healthHistory.length > MAX_HEALTH_HISTORY) {
    state.healthHistory = state.healthHistory.slice(-MAX_HEALTH_HISTORY);
  }

  const data: Record<string, string> = {
    [STATE_KEY]: JSON.stringify(state, null, 2),
  };

  try {
    await getApi().readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE });
    // Exists — patch it
    await getApi().patchNamespacedConfigMap(
      { name: CONFIGMAP_NAME, namespace: NAMESPACE, body: { data }, },
    );
    log.debug('state ConfigMap updated');
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number } }).response?.statusCode;
    if (status === 404) {
      // Create it
      await getApi().createNamespacedConfigMap({
        namespace: NAMESPACE,
        body: {
          metadata: { name: CONFIGMAP_NAME, namespace: NAMESPACE },
          data,
        },
      });
      log.info('state ConfigMap created');
    } else {
      log.error({ err }, 'failed to save state ConfigMap');
      throw err;
    }
  }
}

/**
 * Save the runtime prompt to the ConfigMap.
 */
export async function saveRuntimePrompt(content: string): Promise<void> {
  const data = { [RUNTIME_PROMPT_KEY]: content };

  try {
    await getApi().patchNamespacedConfigMap(
      { name: CONFIGMAP_NAME, namespace: NAMESPACE, body: { data }, },
    );
    log.info('runtime prompt saved to ConfigMap');
  } catch (err) {
    log.error({ err }, 'failed to save runtime prompt');
    throw err;
  }
}

/**
 * Load the runtime prompt from the ConfigMap.
 */
export async function loadRuntimePrompt(): Promise<string | undefined> {
  try {
    const resp = await getApi().readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE });
    return resp.data?.[RUNTIME_PROMPT_KEY];
  } catch {
    return undefined;
  }
}
