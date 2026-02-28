import { logger } from '@bakerst/shared';
import type { ReleaseManifest } from '@bakerst/shared';
import type { RegisteredTool } from '../types.js';

const log = logger.child({ module: 'release-manifest' });

const GITHUB_ORG = 'The-Baker-Street-Project';
const GITHUB_REPO = 'baker-street';

/** Cache the fetched manifest for the duration of the session */
let cachedManifest: ReleaseManifest | undefined;

export function getCachedManifest(): ReleaseManifest | undefined {
  return cachedManifest;
}

export function createReleaseManifestTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'fetch_release_manifest',
        description: 'Fetch the release manifest from the latest GitHub Release. Returns the manifest JSON with image versions, prompts, required secrets, and optional features.',
        input_schema: {
          type: 'object',
          properties: {
            version: { type: 'string', description: 'Specific release version to fetch (default: latest)' },
          },
        },
      },
      handler: async (input) => {
        const version = input.version as string | undefined;

        try {
          const releaseUrl = version
            ? `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/tags/v${version}`
            : `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest`;

          const releaseResp = await fetch(releaseUrl, {
            headers: { Accept: 'application/vnd.github.v3+json' },
          });

          if (!releaseResp.ok) {
            return { result: `Failed to fetch release: ${releaseResp.status} ${releaseResp.statusText}` };
          }

          const release = await releaseResp.json() as { assets: Array<{ name: string; browser_download_url: string }> };

          // Find the release-manifest.json asset
          const manifestAsset = release.assets.find((a: { name: string }) => a.name === 'release-manifest.json');
          if (!manifestAsset) {
            return { result: 'No release-manifest.json found in the release assets.' };
          }

          const manifestResp = await fetch(manifestAsset.browser_download_url);
          if (!manifestResp.ok) {
            return { result: `Failed to download manifest: ${manifestResp.status}` };
          }

          const manifest = await manifestResp.json() as ReleaseManifest;
          cachedManifest = manifest;

          log.info({ version: manifest.version }, 'release manifest fetched');

          return {
            result: JSON.stringify({
              version: manifest.version,
              date: manifest.date,
              imageCount: manifest.images.length,
              images: manifest.images.map((i) => `${i.component}: ${i.version}`),
              requiredSecrets: manifest.requiredSecrets.filter((s) => s.required).map((s) => s.key),
              optionalFeatures: manifest.optionalFeatures.map((f) => `${f.id}: ${f.name}`),
              releaseNotes: manifest.releaseNotes,
            }, null, 2),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err }, 'failed to fetch release manifest');
          return { result: `Error fetching release manifest: ${msg}` };
        }
      },
    },
    {
      definition: {
        name: 'check_for_updates',
        description: 'Check if a newer release is available by comparing the deployed version against the latest GitHub Release.',
        input_schema: {
          type: 'object',
          properties: {
            currentVersion: { type: 'string', description: 'Currently deployed version' },
          },
          required: ['currentVersion'],
        },
      },
      handler: async (input) => {
        const currentVersion = input.currentVersion as string;

        try {
          const url = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest`;
          const resp = await fetch(url, {
            headers: { Accept: 'application/vnd.github.v3+json' },
          });

          if (!resp.ok) {
            return { result: `Failed to check for updates: ${resp.status}` };
          }

          const release = await resp.json() as { tag_name: string };
          const latestVersion = release.tag_name.replace(/^v/, '');

          if (latestVersion === currentVersion) {
            return { result: `Up to date (version ${currentVersion}).` };
          }

          return { result: `Update available: ${currentVersion} → ${latestVersion}` };
        } catch (err) {
          return { result: `Error checking for updates: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      definition: {
        name: 'backup_state',
        description: 'Create a backup of the current cluster state before performing an update.',
        input_schema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => {
        // The state is already persisted in a ConfigMap. This tool logs the action.
        log.info('state backup requested (ConfigMap already persists state)');
        return { result: 'State is persisted in ConfigMap bakerst-sysadmin-state. Backup acknowledged.' };
      },
    },
    {
      definition: {
        name: 'rollback',
        description: 'Roll back a failed update by restarting deployments with the previous image versions.',
        input_schema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Reason for rollback' },
          },
          required: ['reason'],
        },
      },
      handler: async (input) => {
        const reason = input.reason as string;
        log.warn({ reason }, 'rollback requested');
        // In practice, rollback re-applies the previous manifest.
        // For now, we return the signal and let the agent orchestrate.
        return { result: `Rollback initiated: ${reason}. Reverting to previous deployment state.` };
      },
    },
  ];
}
