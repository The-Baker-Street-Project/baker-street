/**
 * Schedule Tools — exposes the ScheduleManager as agent-callable tools
 * using "standing order" vocabulary to match the Bakerized naming convention.
 */

import { logger } from '@bakerst/shared';
import type { ScheduleManager } from './schedule-manager.js';
import type { ScheduleRow } from './db.js';

const log = logger.child({ module: 'schedule-tools' });

type ToolInput = Record<string, unknown>;

export const SCHEDULE_TOOLS = new Set([
  'manage_standing_order',
  'list_standing_orders',
  'trigger_standing_order',
]);

export async function executeScheduleTool(
  toolName: string,
  input: ToolInput,
  scheduleManager: ScheduleManager,
): Promise<{ result: string }> {
  switch (toolName) {
    case 'manage_standing_order':
      return handleManageStandingOrder(input, scheduleManager);
    case 'list_standing_orders':
      return handleListStandingOrders(input, scheduleManager);
    case 'trigger_standing_order':
      return handleTriggerStandingOrder(input, scheduleManager);
    default:
      return { result: `Unknown schedule tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// manage_standing_order
// ---------------------------------------------------------------------------

/** Validate a webhook URL for SSRF protection. Returns an error string or null if valid. */
export function validateWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return 'Webhook URL must use HTTPS';
    }
    const hostname = parsed.hostname;
    // Block private IP ranges
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      // Block internal K8s DNS
      hostname.endsWith('.svc.cluster.local') ||
      hostname.endsWith('.cluster.local')
    ) {
      return 'Webhook URL must not target private/internal addresses';
    }
    return null;
  } catch {
    return 'Invalid webhook URL';
  }
}

interface ManageInput {
  action: 'create' | 'update' | 'enable' | 'disable' | 'delete';
  id?: string;
  name?: string;
  schedule?: string;
  type?: string;
  config?: Record<string, unknown>;
  case_file?: string;
  max_consecutive_failures?: number;
}

function handleManageStandingOrder(
  input: ToolInput,
  scheduleManager: ScheduleManager,
): { result: string } {
  const { action, id, name, schedule, type, config, case_file, max_consecutive_failures } = input as unknown as ManageInput;

  switch (action) {
    case 'create': {
      if (!name || !schedule || !type) {
        return { result: 'Error: name, schedule (cron expression), and type are required for create' };
      }

      // Validate case_file
      if (case_file && !['sitting-room', 'private'].includes(case_file)) {
        return { result: 'Error: case_file must be "sitting-room" or "private"' };
      }

      // SSRF protection for pigeon (webhook) delivery
      const delivery = config?.delivery as { mode?: string; url?: string } | undefined;
      if (delivery?.mode === 'pigeon' && delivery?.url) {
        const urlError = validateWebhookUrl(delivery.url);
        if (urlError) {
          return { result: `Error: ${urlError}` };
        }
      }

      try {
        const row = scheduleManager.create({
          name,
          schedule,
          type,
          config: config ?? {},
          case_file,
          max_consecutive_failures,
        });
        log.info({ id: row.id, name }, 'agent created standing order');
        return {
          result: `Standing order "${name}" created successfully.\n` +
            `  ID: ${row.id}\n` +
            `  Schedule: ${row.schedule}\n` +
            `  Type: ${row.type}\n` +
            `  Case file: ${row.case_file}\n` +
            `  Enabled: ${row.enabled ? 'yes' : 'no'}`,
        };
      } catch (err) {
        return { result: `Error creating standing order: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'update': {
      if (!id) {
        return { result: 'Error: id is required for update' };
      }

      const existing = scheduleManager.get(id);
      if (!existing) {
        return { result: `Error: standing order '${id}' not found` };
      }

      // Validate case_file
      if (case_file && !['sitting-room', 'private'].includes(case_file)) {
        return { result: 'Error: case_file must be "sitting-room" or "private"' };
      }

      // SSRF protection for pigeon (webhook) delivery
      const delivery = config?.delivery as { mode?: string; url?: string } | undefined;
      if (delivery?.mode === 'pigeon' && delivery?.url) {
        const urlError = validateWebhookUrl(delivery.url);
        if (urlError) {
          return { result: `Error: ${urlError}` };
        }
      }

      const updates: Partial<{ name: string; schedule: string; type: string; config: Record<string, unknown>; case_file: string; max_consecutive_failures: number }> = {};
      if (name !== undefined) updates.name = name;
      if (schedule !== undefined) updates.schedule = schedule;
      if (type !== undefined) updates.type = type;
      if (config !== undefined) updates.config = config;
      if (case_file !== undefined) updates.case_file = case_file;
      if (max_consecutive_failures !== undefined) updates.max_consecutive_failures = max_consecutive_failures;

      try {
        const updated = scheduleManager.update(id, updates);
        if (!updated) {
          return { result: `Error: failed to update standing order '${id}'` };
        }
        log.info({ id }, 'agent updated standing order');
        return { result: `Standing order '${id}' updated successfully` };
      } catch (err) {
        return { result: `Error updating standing order: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'enable': {
      if (!id) {
        return { result: 'Error: id is required for enable' };
      }

      const existing = scheduleManager.get(id);
      if (!existing) {
        return { result: `Error: standing order '${id}' not found` };
      }

      try {
        scheduleManager.update(id, { enabled: true });
        log.info({ id }, 'agent enabled standing order');
        return { result: `Standing order '${id}' enabled successfully` };
      } catch (err) {
        return { result: `Error enabling standing order: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'disable': {
      if (!id) {
        return { result: 'Error: id is required for disable' };
      }

      const existing = scheduleManager.get(id);
      if (!existing) {
        return { result: `Error: standing order '${id}' not found` };
      }

      try {
        scheduleManager.update(id, { enabled: false });
        log.info({ id }, 'agent disabled standing order');
        return { result: `Standing order '${id}' disabled successfully` };
      } catch (err) {
        return { result: `Error disabling standing order: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'delete': {
      if (!id) {
        return { result: 'Error: id is required for delete' };
      }

      const existing = scheduleManager.get(id);
      if (!existing) {
        return { result: `Error: standing order '${id}' not found` };
      }

      const deleted = scheduleManager.delete(id);
      if (!deleted) {
        return { result: `Error: failed to delete standing order '${id}'` };
      }
      log.info({ id }, 'agent deleted standing order');
      return { result: `Standing order '${id}' deleted successfully` };
    }

    default:
      return { result: `Error: unknown action '${action}'. Must be: create, update, enable, disable, delete` };
  }
}

// ---------------------------------------------------------------------------
// list_standing_orders
// ---------------------------------------------------------------------------

interface ListInput {
  status?: 'enabled' | 'disabled' | 'all';
}

function handleListStandingOrders(
  input: ToolInput,
  scheduleManager: ScheduleManager,
): { result: string } {
  const { status = 'all' } = input as ListInput;
  const allRows = scheduleManager.list();

  let filtered: ScheduleRow[];
  if (status === 'enabled') {
    filtered = allRows.filter((r) => r.enabled);
  } else if (status === 'disabled') {
    filtered = allRows.filter((r) => !r.enabled);
  } else {
    filtered = allRows;
  }

  if (filtered.length === 0) {
    return { result: status === 'all' ? 'No standing orders found.' : `No ${status} standing orders found.` };
  }

  const lines = filtered.map((r) => {
    const enabledStr = r.enabled ? 'enabled' : 'disabled';
    const lastRun = r.last_run_at ?? 'never';
    const lastStatus = r.last_status ?? 'n/a';
    return `- ${r.name} (${r.id})\n  Schedule: ${r.schedule} | Type: ${r.type} | Status: ${enabledStr}\n  Last run: ${lastRun} | Last status: ${lastStatus}`;
  });

  return { result: `${filtered.length} standing order(s):\n\n${lines.join('\n\n')}` };
}

// ---------------------------------------------------------------------------
// trigger_standing_order
// ---------------------------------------------------------------------------

interface TriggerInput {
  id: string;
}

async function handleTriggerStandingOrder(
  input: ToolInput,
  scheduleManager: ScheduleManager,
): Promise<{ result: string }> {
  const { id } = input as unknown as TriggerInput;

  if (!id) {
    return { result: 'Error: id is required' };
  }

  try {
    const jobId = await scheduleManager.trigger(id);
    log.info({ id, jobId }, 'agent triggered standing order');
    return { result: `Standing order '${id}' triggered. Job ID: ${jobId}` };
  } catch (err) {
    return { result: `Error triggering standing order: ${err instanceof Error ? err.message : String(err)}` };
  }
}
