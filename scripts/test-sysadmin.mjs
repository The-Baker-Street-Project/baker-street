#!/usr/bin/env node

/**
 * SysAdmin Deploy Flow Test Harness
 *
 * Connects via WebSocket to the sysadmin terminal, drives the deploy conversation,
 * and auto-answers ask_user questions with actual values from K8s secrets.
 *
 * Usage:
 *   node scripts/test-sysadmin.mjs                  # run against localhost:30090
 *   node scripts/test-sysadmin.mjs --url ws://host:port/terminal
 *   node scripts/test-sysadmin.mjs --dry-run        # print answers without connecting
 */

import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const urlIdx = args.indexOf('--url');
const WS_URL = urlIdx >= 0 ? args[urlIdx + 1] : 'ws://localhost:30090/terminal';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 min total timeout

// ---------------------------------------------------------------------------
// Load secrets from K8s (no shell — uses execFileSync with explicit args)
// ---------------------------------------------------------------------------

function k8sSecret(secret, key) {
  try {
    const raw = execFileSync('kubectl', [
      'get', 'secret', secret, '-n', 'bakerst',
      '-o', `jsonpath={.data.${key}}`,
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!raw) return '';
    return execFileSync('base64', ['-d'], {
      input: raw,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

const secrets = {
  ANTHROPIC_API_KEY: k8sSecret('bakerst-brain-secrets', 'ANTHROPIC_API_KEY'),
  AGENT_NAME: k8sSecret('bakerst-brain-secrets', 'AGENT_NAME') || 'Baker',
  AUTH_TOKEN: k8sSecret('bakerst-brain-secrets', 'AUTH_TOKEN'),
  TELEGRAM_BOT_TOKEN: k8sSecret('bakerst-gateway-secrets', 'TELEGRAM_BOT_TOKEN'),
  DISCORD_BOT_TOKEN: k8sSecret('bakerst-gateway-secrets', 'DISCORD_BOT_TOKEN'),
  VOYAGE_API_KEY: k8sSecret('bakerst-brain-secrets', 'VOYAGE_API_KEY'),
  GITHUB_TOKEN: k8sSecret('bakerst-github-secrets', 'GITHUB_TOKEN'),
  OBSIDIAN_VAULT_PATH: '',
  TELEGRAM_ALLOWED_CHAT_IDS: k8sSecret('bakerst-gateway-secrets', 'TELEGRAM_ALLOWED_CHAT_IDS'),
};

console.log('\n=== SysAdmin Test Harness ===');
console.log('Secrets loaded:');
for (const [k, v] of Object.entries(secrets)) {
  console.log(`  ${k}: ${v ? '✓ (' + v.slice(0, 8) + '...)' : '✗ (empty)'}`);
}

if (dryRun) {
  console.log('\n[dry-run] Would connect to:', WS_URL);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Answer matching
// ---------------------------------------------------------------------------

/** Match a question to an answer based on keywords */
function autoAnswer(question, inputType, choices) {
  const q = question.toLowerCase();

  // Choice-type: select features that have tokens available
  if (inputType === 'choice' && choices) {
    const selected = [];
    if (secrets.TELEGRAM_BOT_TOKEN) selected.push(choices.find(c => c.toLowerCase().includes('telegram')));
    if (secrets.VOYAGE_API_KEY) selected.push(choices.find(c => c.toLowerCase().includes('voyage')));
    if (secrets.GITHUB_TOKEN) selected.push(choices.find(c => c.toLowerCase().includes('github')));
    const valid = selected.filter(Boolean);
    return valid.length > 0 ? valid.join(', ') : 'none';
  }

  // Secret-type: match by keyword
  if (q.includes('anthropic') || q.includes('api key')) return secrets.ANTHROPIC_API_KEY;
  if (q.includes('auth token')) return secrets.AUTH_TOKEN || 'skip';
  if (q.includes('telegram') && q.includes('token')) return secrets.TELEGRAM_BOT_TOKEN;
  if (q.includes('telegram') && q.includes('chat')) return secrets.TELEGRAM_ALLOWED_CHAT_IDS || 'skip';
  if (q.includes('discord') && q.includes('token')) return secrets.DISCORD_BOT_TOKEN || 'skip';
  if (q.includes('voyage')) return secrets.VOYAGE_API_KEY || 'skip';
  if (q.includes('github') && q.includes('token')) return secrets.GITHUB_TOKEN || 'skip';
  if (q.includes('obsidian') || q.includes('vault')) return secrets.OBSIDIAN_VAULT_PATH || 'skip';
  if (q.includes('agent name') || q.includes('name your') || q.includes('persona')) return secrets.AGENT_NAME;

  // Feature selection as text
  if (q.includes('feature') || q.includes('optional')) {
    const features = [];
    if (secrets.TELEGRAM_BOT_TOKEN) features.push('telegram');
    if (secrets.VOYAGE_API_KEY) features.push('voyage');
    if (secrets.GITHUB_TOKEN) features.push('github');
    return features.length > 0 ? features.join(', ') : 'none';
  }

  // Ready prompts
  if (q.includes('ready') || q.includes('begin') || q.includes('proceed') || q.includes('continue')) {
    return 'yes';
  }

  // Default
  console.log(`  [!] No auto-answer for: "${question.slice(0, 80)}..."`);
  return 'skip';
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

console.log(`\nConnecting to ${WS_URL}...\n`);

const ws = new WebSocket(WS_URL);
let conversationLog = [];
let started = false;

const globalTimeout = setTimeout(() => {
  console.log('\n[TIMEOUT] 10 minutes elapsed, closing.');
  log('TIMEOUT', '10 minutes elapsed');
  finish();
}, TIMEOUT_MS);

function log(type, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${type}: ${msg}`;
  conversationLog.push(line);
  console.log(line);
}

function finish() {
  clearTimeout(globalTimeout);
  console.log('\n=== Conversation Log ===');
  conversationLog.forEach(l => console.log(l));
  console.log('========================\n');
  ws.close();
  process.exit(0);
}

ws.on('open', () => {
  log('SYSTEM', 'Connected to SysAdmin terminal');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'status') {
    log('STATUS', `state=${msg.state}`);
    // Send initial message to kick off deploy
    if (!started) {
      started = true;
      setTimeout(() => {
        log('USER', 'Start the deployment');
        ws.send(JSON.stringify({ type: 'chat', message: 'Start the deployment' }));
      }, 1000);
    }
    return;
  }

  if (msg.type === 'text') {
    log('AGENT', msg.content);

    // If agent says "ready" or waits, respond
    const lower = msg.content.toLowerCase();
    if (lower.includes('gather any keys') || lower.includes("when you're ready") || lower.includes('when you are ready')) {
      setTimeout(() => {
        log('USER', "I'm ready, let's go");
        ws.send(JSON.stringify({ type: 'chat', message: "I'm ready, let's go" }));
      }, 500);
    }

    // If agent mentions transition to runtime or all healthy
    if (lower.includes('transition') && lower.includes('runtime')) {
      log('SYSTEM', 'Deploy complete — agent transitioning to runtime');
      setTimeout(finish, 2000);
    }
    return;
  }

  if (msg.type === 'ask') {
    log('ASK', `[${msg.inputType}] ${msg.question}`);
    if (msg.choices) log('ASK', `  choices: ${msg.choices.join(', ')}`);

    const answer = autoAnswer(msg.question, msg.inputType, msg.choices);
    const displayAnswer = msg.inputType === 'secret' ? answer.slice(0, 8) + '...' : answer;
    log('ANSWER', displayAnswer);

    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'answer', id: msg.id, value: answer }));
    }, 300);
    return;
  }

  if (msg.type === 'thinking') {
    log('THINKING', `Using ${msg.tool}...`);
    return;
  }

  if (msg.type === 'error') {
    log('ERROR', msg.message);
    return;
  }
});

ws.on('close', () => {
  log('SYSTEM', 'Disconnected');
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});
