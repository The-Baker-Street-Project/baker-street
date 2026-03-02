import * as k8s from '@kubernetes/client-node';
import type { RegisteredTool, ToolResult } from '../types.js';

const NAMESPACE = process.env.NAMESPACE ?? 'bakerst';

/** Known feature flags from packages/shared/src/features.ts */
const KNOWN_FLAGS: Record<string, string> = {
  telegram: 'FEATURE_TELEGRAM',
  discord: 'FEATURE_DISCORD',
  mcp: 'FEATURE_MCP',
  scheduler: 'FEATURE_SCHEDULER',
  observer: 'FEATURE_OBSERVER',
  reflector: 'FEATURE_REFLECTOR',
  memory: 'FEATURE_MEMORY',
  transferProtocol: 'FEATURE_TRANSFER_PROTOCOL',
  telemetry: 'FEATURE_TELEMETRY',
  taskPods: 'FEATURE_TASK_PODS',
  companions: 'FEATURE_COMPANIONS',
  extensions: 'FEATURE_EXTENSIONS',
};

const ENV_TO_FLAG: Record<string, string> = {};
for (const [flag, env] of Object.entries(KNOWN_FLAGS)) {
  ENV_TO_FLAG[env] = flag;
}

const FLAG_SECRETS: Record<string, string[]> = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  discord: ['DISCORD_BOT_TOKEN'],
  memory: ['VOYAGE_API_KEY'],
};

const MODE_DEFAULTS: Record<string, Record<string, boolean>> = {
  prod: { telegram: true, discord: true, mcp: true, scheduler: true, observer: true, reflector: true, memory: true, transferProtocol: true, telemetry: true, taskPods: false, companions: false, extensions: false },
  dev: { telegram: false, discord: false, mcp: false, scheduler: false, observer: true, reflector: true, memory: true, transferProtocol: false, telemetry: false, taskPods: false, companions: false, extensions: false },
};

let appsApi: k8s.AppsV1Api;

function getAppsApi(): k8s.AppsV1Api {
  if (!appsApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    appsApi = kc.makeApiClient(k8s.AppsV1Api);
  }
  return appsApi;
}

export function createFeatureFlagTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'get_feature_flags',
        description: 'Get the current feature flag state from the brain deployment. Shows which FEATURE_* env vars are set and their values, plus known flags using mode defaults.',
        input_schema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_input: Record<string, unknown>): Promise<ToolResult> => {
        const api = getAppsApi();
        const dep = await api.readNamespacedDeployment({ name: 'brain', namespace: NAMESPACE });
        const envVars = dep.spec?.template?.spec?.containers?.[0]?.env ?? [];

        const flags: Record<string, { value: string; source: string }> = {};

        for (const env of envVars) {
          if (env.name?.startsWith('FEATURE_') && ENV_TO_FLAG[env.name]) {
            flags[ENV_TO_FLAG[env.name]] = {
              value: env.value ?? 'unset',
              source: 'env override',
            };
          }
        }

        const modeVar = envVars.find((e) => e.name === 'BAKERST_MODE');
        const mode = modeVar?.value ?? 'prod';
        const defaults = MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.prod;

        for (const [flag, defaultVal] of Object.entries(defaults)) {
          if (!flags[flag]) {
            flags[flag] = { value: String(defaultVal), source: `${mode} default` };
          }
        }

        const lines = [`Feature flags for brain (mode: ${mode}):\n`];
        for (const [flag, info] of Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))) {
          const icon = info.value === 'true' ? '\u2713' : '\u2717';
          lines.push(`  ${icon} ${flag}: ${info.value} (${info.source})`);
        }
        return { result: lines.join('\n') };
      },
    },
    {
      definition: {
        name: 'set_feature_flag',
        description: 'Enable or disable a feature flag on the brain deployment. Sets the FEATURE_* env var and triggers a rollout restart.',
        input_schema: {
          type: 'object' as const,
          properties: {
            flag: {
              type: 'string',
              description: 'Feature flag name',
              enum: Object.keys(KNOWN_FLAGS),
            },
            enabled: {
              type: 'boolean',
              description: 'Whether to enable or disable the feature',
            },
          },
          required: ['flag', 'enabled'],
        },
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const flag = input.flag as string;
        const enabled = input.enabled as boolean;

        if (!KNOWN_FLAGS[flag]) {
          return { result: `Unknown flag: ${flag}. Known: ${Object.keys(KNOWN_FLAGS).join(', ')}` };
        }

        const envName = KNOWN_FLAGS[flag];
        const api = getAppsApi();

        const dep = await api.readNamespacedDeployment({ name: 'brain', namespace: NAMESPACE });
        const containers = dep.spec?.template?.spec?.containers;
        if (!containers?.length) {
          return { result: 'Error: brain deployment has no containers' };
        }

        const env = containers[0].env ?? [];
        const existing = env.findIndex((e) => e.name === envName);
        if (existing >= 0) {
          env[existing] = { name: envName, value: String(enabled) };
        } else {
          env.push({ name: envName, value: String(enabled) });
        }
        containers[0].env = env;

        await api.patchNamespacedDeployment({
          name: 'brain',
          namespace: NAMESPACE,
          body: { spec: { template: { spec: { containers } } } },
        });

        const requiredSecrets = FLAG_SECRETS[flag];
        let secretNote = '';
        if (enabled && requiredSecrets?.length) {
          secretNote = `\n\nNote: ${flag} requires secrets: ${requiredSecrets.join(', ')}. Use ask_user to collect them if not already configured, then create_secret to store them.`;
        }

        return { result: `Feature '${flag}' set to ${enabled} on brain. Rollout restart triggered.${secretNote}` };
      },
    },
  ];
}
