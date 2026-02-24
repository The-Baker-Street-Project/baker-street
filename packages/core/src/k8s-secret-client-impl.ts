/**
 * Default K8sSecretClient implementation using the Kubernetes API directly.
 *
 * Reads service account credentials from the standard pod mount paths.
 * Enterprise deployments can replace this with Vault, AWS Secrets Manager, etc.
 */

import { readFileSync } from 'node:fs';
import { logger } from '@bakerst/shared';
import type { SecretData, K8sSecretClient } from './k8s-secret-client.js';

const log = logger.child({ module: 'k8s-secret-client' });

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_NS_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

function getNamespace(): string {
  try {
    return readFileSync(SA_NS_PATH, 'utf-8').trim();
  } catch {
    return 'bakerst';
  }
}

function getToken(): string {
  return readFileSync(SA_TOKEN_PATH, 'utf-8').trim();
}

function apiBase(): string {
  return 'https://kubernetes.default.svc';
}

async function k8sFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${apiBase()}${path}`;
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    log.error({ status: res.status, body, path }, 'k8s API error');
    throw new Error(`k8s API ${res.status}: ${body}`);
  }
  return res;
}

/**
 * Create a K8sSecretClient backed by the Kubernetes API.
 *
 * @param secretName - Name of the K8s Secret to manage (default: 'bakerst-secrets')
 */
export function createK8sSecretClient(secretName = 'bakerst-secrets'): K8sSecretClient {
  return {
    async getSecrets(): Promise<SecretData> {
      const ns = getNamespace();
      const res = await k8sFetch(`/api/v1/namespaces/${ns}/secrets/${secretName}`);
      const secret = (await res.json()) as { data?: Record<string, string> };
      const decoded: SecretData = {};
      if (secret.data) {
        for (const [key, val] of Object.entries(secret.data)) {
          decoded[key] = Buffer.from(val, 'base64').toString('utf-8');
        }
      }
      return decoded;
    },

    async updateSecrets(data: SecretData): Promise<void> {
      const ns = getNamespace();
      const encoded: Record<string, string> = {};
      for (const [key, val] of Object.entries(data)) {
        encoded[key] = Buffer.from(val, 'utf-8').toString('base64');
      }
      await k8sFetch(`/api/v1/namespaces/${ns}/secrets/${secretName}`, {
        method: 'PUT',
        body: JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: secretName, namespace: ns },
          data: encoded,
        }),
      });
      log.info({ keys: Object.keys(data) }, 'secrets updated');
    },

    async restartDeployment(name: string): Promise<void> {
      const ns = getNamespace();
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'bakerst/restartedAt': new Date().toISOString(),
              },
            },
          },
        },
      };
      await k8sFetch(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
        body: JSON.stringify(patch),
      });
      log.info({ deployment: name }, 'deployment restarted');
    },
  };
}
