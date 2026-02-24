/**
 * K8sSecretClient — abstract contract for Kubernetes secret operations.
 *
 * Extracted from services/brain/src/k8s-client.ts to allow:
 * - Enterprise deployments to use External Secrets Operator or Vault
 * - Testing without a live K8s cluster
 */

export interface SecretData {
  [key: string]: string;
}

export interface K8sSecretClient {
  /** Fetch decoded secret data */
  getSecrets(): Promise<SecretData>;
  /** Update secret data (base64 encoding handled internally) */
  updateSecrets(data: SecretData): Promise<void>;
  /** Restart a deployment by patching its annotations */
  restartDeployment(name: string): Promise<void>;
}
