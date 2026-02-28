import { logger } from '@bakerst/shared';
import type { SysAdminState } from '@bakerst/shared';
import type { RegisteredTool } from './types.js';

const log = logger.child({ module: 'tool-registry' });

/** Tool names available per state */
const STATE_TOOLS: Record<SysAdminState, Set<string>> = {
  deploy: new Set([
    'create_namespace',
    'create_secret',
    'create_configmap',
    'create_deployment',
    'create_service',
    'apply_network_policy',
    'check_pod_health',
    'get_pod_logs',
    'wait_for_rollout',
    'fetch_release_manifest',
    'ask_user',
    'transition_to_runtime',
  ]),
  runtime: new Set([
    'check_pod_health',
    'get_pod_logs',
    'get_cluster_status',
    'verify_image_integrity',
    'restart_deployment',
    'scale_deployment',
    'check_for_updates',
    'transition_to_update',
  ]),
  update: new Set([
    'create_namespace',
    'create_secret',
    'create_configmap',
    'create_deployment',
    'create_service',
    'apply_network_policy',
    'check_pod_health',
    'get_pod_logs',
    'wait_for_rollout',
    'fetch_release_manifest',
    'backup_state',
    'rollback',
    'transition_to_runtime',
  ]),
  shutdown: new Set(),
};

/**
 * Build the tool set for a given state from the full registry of all tools.
 */
export function buildToolsForState(
  state: SysAdminState,
  allTools: RegisteredTool[],
): RegisteredTool[] {
  const allowed = STATE_TOOLS[state];
  const filtered = allTools.filter((t) => allowed.has(t.definition.name));
  log.info({ state, toolCount: filtered.length }, 'built tool set for state');
  return filtered;
}
