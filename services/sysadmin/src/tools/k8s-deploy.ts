import * as k8s from '@kubernetes/client-node';
import { logger } from '@bakerst/shared';
import type { RegisteredTool } from '../types.js';

const log = logger.child({ module: 'k8s-deploy' });

const NAMESPACE = process.env.NAMESPACE ?? 'bakerst';

let appsApi: k8s.AppsV1Api;
let coreApi: k8s.CoreV1Api;
let networkApi: k8s.NetworkingV1Api;

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

function getNetworkApi(): k8s.NetworkingV1Api {
  if (!networkApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    networkApi = kc.makeApiClient(k8s.NetworkingV1Api);
  }
  return networkApi;
}

export function createK8sDeployTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'create_deployment',
        description: 'Create or update a Kubernetes Deployment. Provide the full deployment spec as JSON.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Deployment name' },
            image: { type: 'string', description: 'Container image' },
            port: { type: 'number', description: 'Container port' },
            replicas: { type: 'number', description: 'Number of replicas (default: 1)' },
            env: { type: 'object', description: 'Environment variables as key-value pairs' },
            envFromSecrets: {
              type: 'array',
              items: { type: 'string' },
              description: 'Secret names to inject as envFrom',
            },
            volumeMounts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  mountPath: { type: 'string' },
                  configMapName: { type: 'string' },
                  readOnly: { type: 'boolean' },
                },
              },
              description: 'Volume mounts (ConfigMap or emptyDir)',
            },
            serviceAccountName: { type: 'string', description: 'ServiceAccount to use' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name', 'image'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;
        const image = input.image as string;
        const port = input.port as number | undefined;
        const replicas = (input.replicas as number) ?? 1;
        const envMap = (input.env as Record<string, string>) ?? {};
        const envFromSecrets = (input.envFromSecrets as string[]) ?? [];
        const volumeMountSpecs = (input.volumeMounts as Array<{
          name: string;
          mountPath: string;
          configMapName?: string;
          readOnly?: boolean;
        }>) ?? [];
        const serviceAccountName = input.serviceAccountName as string | undefined;

        const env: k8s.V1EnvVar[] = Object.entries(envMap).map(([k, v]) => ({
          name: k,
          value: String(v),
        }));

        const envFrom: k8s.V1EnvFromSource[] = envFromSecrets.map((secretName) => ({
          secretRef: { name: secretName, optional: true },
        }));

        const volumes: k8s.V1Volume[] = [{ name: 'tmp', emptyDir: {} }];
        const mounts: k8s.V1VolumeMount[] = [{ name: 'tmp', mountPath: '/tmp' }];

        for (const vm of volumeMountSpecs) {
          if (vm.configMapName) {
            volumes.push({ name: vm.name, configMap: { name: vm.configMapName } });
          } else {
            volumes.push({ name: vm.name, emptyDir: {} });
          }
          mounts.push({
            name: vm.name,
            mountPath: vm.mountPath,
            readOnly: vm.readOnly ?? false,
          });
        }

        const deployment: k8s.V1Deployment = {
          metadata: { name, namespace: ns, labels: { app: name } },
          spec: {
            replicas,
            strategy: { type: 'Recreate' },
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels: { app: name } },
              spec: {
                serviceAccountName,
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  fsGroup: 1000,
                  seccompProfile: { type: 'RuntimeDefault' },
                },
                containers: [{
                  name,
                  image,
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  ports: port ? [{ containerPort: port, name: 'http' }] : [],
                  env,
                  envFrom: envFrom.length > 0 ? envFrom : undefined,
                  volumeMounts: mounts,
                  resources: {
                    requests: { memory: '128Mi', cpu: '100m' },
                    limits: { memory: '256Mi', cpu: '500m' },
                  },
                }],
                volumes,
              },
            },
          },
        };

        try {
          await getAppsApi().readNamespacedDeployment({ name, namespace: ns });
          await getAppsApi().replaceNamespacedDeployment({ name, namespace: ns, body: deployment });
          log.info({ name, ns, image }, 'deployment updated');
          return { result: `Deployment "${name}" updated with image ${image}.` };
        } catch {
          await getAppsApi().createNamespacedDeployment({ namespace: ns, body: deployment });
          log.info({ name, ns, image }, 'deployment created');
          return { result: `Deployment "${name}" created with image ${image}.` };
        }
      },
    },
    {
      definition: {
        name: 'create_service',
        description: 'Create or update a Kubernetes Service (NodePort).',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Service name' },
            selector: { type: 'object', description: 'Pod selector labels' },
            port: { type: 'number', description: 'Service port' },
            targetPort: { type: 'number', description: 'Target container port' },
            nodePort: { type: 'number', description: 'NodePort (optional, for external access)' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name', 'selector', 'port', 'targetPort'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;
        const selector = input.selector as Record<string, string>;
        const port = input.port as number;
        const targetPort = input.targetPort as number;
        const nodePort = input.nodePort as number | undefined;

        const service: k8s.V1Service = {
          metadata: { name, namespace: ns },
          spec: {
            type: nodePort ? 'NodePort' : 'ClusterIP',
            selector,
            ports: [{
              port,
              targetPort,
              nodePort,
              name: 'http',
            }],
          },
        };

        try {
          await getCoreApi().readNamespacedService({ name, namespace: ns });
          await getCoreApi().replaceNamespacedService({ name, namespace: ns, body: service });
          log.info({ name, ns }, 'service updated');
          return { result: `Service "${name}" updated.` };
        } catch {
          await getCoreApi().createNamespacedService({ namespace: ns, body: service });
          log.info({ name, ns }, 'service created');
          return { result: `Service "${name}" created.` };
        }
      },
    },
    {
      definition: {
        name: 'scale_deployment',
        description: 'Scale a Deployment to a specified number of replicas.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Deployment name' },
            replicas: { type: 'number', description: 'Desired replica count' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name', 'replicas'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;
        const replicas = input.replicas as number;

        await getAppsApi().patchNamespacedDeployment({
          name,
          namespace: ns,
          body: { spec: { replicas } },
        });
        log.info({ name, ns, replicas }, 'deployment scaled');
        return { result: `Deployment "${name}" scaled to ${replicas} replicas.` };
      },
    },
    {
      definition: {
        name: 'restart_deployment',
        description: 'Restart a Deployment by triggering a rollout restart.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Deployment name' },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;

        // Trigger rollout restart by patching the template annotation
        await getAppsApi().patchNamespacedDeployment({
          name,
          namespace: ns,
          body: {
            spec: {
              template: {
                metadata: {
                  annotations: {
                    'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
                  },
                },
              },
            },
          },
        });
        log.info({ name, ns }, 'deployment restarted');
        return { result: `Deployment "${name}" restarting.` };
      },
    },
    {
      definition: {
        name: 'apply_network_policy',
        description: 'Create or update a Kubernetes NetworkPolicy.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'NetworkPolicy name' },
            podSelector: { type: 'object', description: 'Pod selector matchLabels' },
            policyTypes: {
              type: 'array',
              items: { type: 'string', enum: ['Ingress', 'Egress'] },
              description: 'Policy types to apply',
            },
            ingressRules: {
              type: 'array',
              description: 'Ingress rules (array of {from, ports})',
            },
            egressRules: {
              type: 'array',
              description: 'Egress rules (array of {to, ports})',
            },
            namespace: { type: 'string', description: 'Namespace (default: bakerst)' },
          },
          required: ['name', 'podSelector', 'policyTypes'],
        },
      },
      handler: async (input) => {
        const name = input.name as string;
        const ns = (input.namespace as string) ?? NAMESPACE;

        const policy: k8s.V1NetworkPolicy = {
          metadata: { name, namespace: ns },
          spec: {
            podSelector: { matchLabels: input.podSelector as Record<string, string> },
            policyTypes: input.policyTypes as ('Ingress' | 'Egress')[],
            ingress: input.ingressRules as k8s.V1NetworkPolicyIngressRule[] | undefined,
            egress: input.egressRules as k8s.V1NetworkPolicyEgressRule[] | undefined,
          },
        };

        try {
          await getNetworkApi().readNamespacedNetworkPolicy({ name, namespace: ns });
          await getNetworkApi().replaceNamespacedNetworkPolicy({ name, namespace: ns, body: policy });
          log.info({ name, ns }, 'network policy updated');
          return { result: `NetworkPolicy "${name}" updated.` };
        } catch {
          await getNetworkApi().createNamespacedNetworkPolicy({ namespace: ns, body: policy });
          log.info({ name, ns }, 'network policy created');
          return { result: `NetworkPolicy "${name}" created.` };
        }
      },
    },
  ];
}
