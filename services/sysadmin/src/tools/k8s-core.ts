import * as k8s from '@kubernetes/client-node';
import { logger } from '@bakerst/shared';
import type { RegisteredTool } from '../types.js';

const log = logger.child({ module: 'k8s-core' });

const NAMESPACE = process.env.NAMESPACE ?? 'bakerst';

let coreApi: k8s.CoreV1Api;

function getApi(): k8s.CoreV1Api {
  if (!coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return coreApi;
}

export function createK8sCoreTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'create_namespace',
        description: 'Create a Kubernetes namespace if it does not already exist.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Namespace name' },
          },
          required: ['name'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        try {
          await getApi().readNamespace({ name });
          return { result: `Namespace "${name}" already exists.` };
        } catch {
          await getApi().createNamespace({
            body: { metadata: { name } },
          });
          log.info({ namespace: name }, 'namespace created');
          return { result: `Namespace "${name}" created.` };
        }
      },
    },
    {
      definition: {
        name: 'create_secret',
        description: 'Create or update a Kubernetes Secret in the target namespace.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Secret name' },
            data: {
              type: 'object',
              description: 'Key-value pairs (values will be base64-encoded automatically)',
            },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name', 'data'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;
        const rawData = input.data as Record<string, string>;

        // Base64 encode values
        const stringData: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawData)) {
          stringData[k] = v;
        }

        const secret: k8s.V1Secret = {
          metadata: { name, namespace: ns },
          stringData,
        };

        try {
          await getApi().readNamespacedSecret({ name, namespace: ns });
          await getApi().replaceNamespacedSecret({ name, namespace: ns, body: secret });
          log.info({ name, namespace: ns }, 'secret updated');
          return { result: `Secret "${name}" updated in namespace "${ns}".` };
        } catch {
          await getApi().createNamespacedSecret({ namespace: ns, body: secret });
          log.info({ name, namespace: ns }, 'secret created');
          return { result: `Secret "${name}" created in namespace "${ns}".` };
        }
      },
    },
    {
      definition: {
        name: 'create_configmap',
        description: 'Create or update a Kubernetes ConfigMap in the target namespace.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'ConfigMap name' },
            data: { type: 'object', description: 'Key-value pairs of config data' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name', 'data'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;
        const data = input.data as Record<string, string>;

        const configMap: k8s.V1ConfigMap = {
          metadata: { name, namespace: ns },
          data,
        };

        try {
          await getApi().readNamespacedConfigMap({ name, namespace: ns });
          await getApi().replaceNamespacedConfigMap({ name, namespace: ns, body: configMap });
          log.info({ name, namespace: ns }, 'configmap updated');
          return { result: `ConfigMap "${name}" updated in namespace "${ns}".` };
        } catch {
          await getApi().createNamespacedConfigMap({ namespace: ns, body: configMap });
          log.info({ name, namespace: ns }, 'configmap created');
          return { result: `ConfigMap "${name}" created in namespace "${ns}".` };
        }
      },
    },
  ];
}
