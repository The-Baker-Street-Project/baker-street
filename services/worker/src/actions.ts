import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type JobDispatch, logger } from '@bakerst/shared';
import type { ModelRouter } from '@bakerst/shared';

const execFileAsync = promisify(execFile);

const log = logger.child({ module: 'actions' });

const DEFAULT_ALLOWED_COMMANDS =
  'kubectl,curl,ls,df,uptime,date,whoami,cat,echo,grep,ps,dig,nslookup,ping,traceroute,helm';
const MAX_COMMAND_LENGTH = 1024;
const MAX_AGENT_JOB_LENGTH = 10_000;

const allowedCommands: Set<string> = new Set(
  (process.env.ALLOWED_COMMANDS ?? DEFAULT_ALLOWED_COMMANDS)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),
);

interface ParsedCommand {
  binary: string;
  args: string[];
  env: Record<string, string>;
}

const BLOCKED_ENV_KEYS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
  'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AUTH_TOKEN',
  'VOYAGE_API_KEY', 'HOME', 'USER',
]);

/**
 * Quote-aware tokenizer that handles double and single quoted arguments.
 * For example: `kubectl get pods -l "app=myservice"` correctly keeps `app=myservice` as one token.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;

  for (const ch of command.trim()) {
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse a command string into binary, args, and env vars.
 * Validates command length and binary against the allowlist.
 * Leading tokens containing '=' (that don't start with '-') are treated as env var assignments.
 */
function parseCommand(command: string): ParsedCommand {
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`command rejected: exceeds max length of ${MAX_COMMAND_LENGTH} characters`);
  }

  const tokens = tokenize(command);
  const env: Record<string, string> = {};
  let binaryIndex = -1;

  // Separate leading env var assignments from the actual command
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Env var assignments: contain '=' and don't start with '-' (to avoid confusing --flag=value)
    if (token.includes('=') && !token.startsWith('-')) {
      const eqIdx = token.indexOf('=');
      const key = token.slice(0, eqIdx);
      if (BLOCKED_ENV_KEYS.has(key)) {
        throw new Error(`command rejected: cannot override env var '${key}'`);
      }
      const value = token.slice(eqIdx + 1);
      env[key] = value;
    } else {
      binaryIndex = i;
      break;
    }
  }

  if (binaryIndex === -1) {
    throw new Error('command rejected: empty command');
  }

  const binary = tokens[binaryIndex];
  const args = tokens.slice(binaryIndex + 1);

  // Strip any path prefix to get the bare binary name
  const baseName = binary.split('/').pop()!;

  if (!allowedCommands.has(baseName)) {
    log.warn({ command: command.slice(0, 200), binary: baseName }, 'command rejected: not in allowlist');
    throw new Error(`command rejected: '${baseName}' is not in the allowed commands list`);
  }

  return { binary: baseName, args, env };
}

/** Remove ANSI escape codes from a string. */
function stripAnsi(str: string): string {
  // Matches ANSI escape sequences: CSI sequences, OSC sequences, and simple escape codes
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[\]]/g, '');
}

async function loadSystemPrompt(): Promise<string> {
  const osDir = process.env.OS_DIR ?? '/etc/bakerst';
  const parts: string[] = [];

  for (const file of ['SOUL.md', 'WORKER.md']) {
    try {
      const content = await readFile(`${osDir}/${file}`, 'utf-8');
      parts.push(content.replaceAll('{{AGENT_NAME}}', process.env.AGENT_NAME ?? 'Baker'));
    } catch {
      log.warn({ file }, 'could not load operating system file');
    }
  }

  return parts.join('\n\n---\n\n');
}

export async function executeAgent(job: JobDispatch, modelRouter: ModelRouter): Promise<string> {
  if (!job.job) throw new Error('agent job requires a "job" field');

  if (job.job.length > MAX_AGENT_JOB_LENGTH) {
    throw new Error(`agent job rejected: exceeds max length of ${MAX_AGENT_JOB_LENGTH} characters`);
  }

  const useOAuth = modelRouter.useOAuth;
  const osPrompt = await loadSystemPrompt();

  // Build system blocks — OAuth tokens require the Claude Code identity prefix
  const systemBlocks: Array<{ type: 'text'; text: string }> = [];
  if (useOAuth) {
    systemBlocks.push({ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' });
  }
  if (osPrompt) {
    systemBlocks.push({ type: 'text', text: osPrompt });
  }

  // Use the 'worker' role if defined, otherwise fall back to 'agent'
  const workerRole = modelRouter.routerConfig.roles.worker ? 'worker' : 'agent';

  const response = await modelRouter.chat({
    role: workerRole,
    system: systemBlocks,
    messages: [{ role: 'user', content: job.job }],
    maxTokens: 1024,
  });

  const text = response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return text;
}

export async function executeCommand(job: JobDispatch): Promise<string> {
  if (!job.command) throw new Error('command job requires a "command" field');

  const parsed = parseCommand(job.command);

  try {
    const { stdout } = await execFileAsync(parsed.binary, parsed.args, {
      timeout: 30_000,
      env: { ...process.env, ...parsed.env },
    });
    return stripAnsi(stdout.trim());
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string };
    throw new Error(`command failed: ${error.message}\nstderr: ${error.stderr ?? ''}`);
  }
}

export async function executeHttp(job: JobDispatch): Promise<string> {
  if (!job.url) throw new Error('http job requires a "url" field');

  // Validate URL scheme — only http:// and https:// are allowed
  let parsed: URL;
  try {
    parsed = new URL(job.url);
  } catch {
    throw new Error('http job rejected: invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`http job rejected: unsupported URL scheme '${parsed.protocol}'`);
  }

  const response = await fetch(job.url, {
    method: job.method ?? 'GET',
    headers: job.headers,
    body: job.vars ? JSON.stringify(job.vars) : undefined,
  });

  const body = await response.text();
  return `HTTP ${response.status}: ${body.slice(0, 2048)}`;
}

export async function executeJob(job: JobDispatch, modelRouter: ModelRouter): Promise<string> {
  switch (job.type) {
    case 'agent':
      return executeAgent(job, modelRouter);
    case 'command':
      return executeCommand(job);
    case 'http':
      return executeHttp(job);
    default:
      throw new Error(`unknown job type: ${job.type}`);
  }
}
