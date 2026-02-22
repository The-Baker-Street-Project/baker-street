#!/usr/bin/env pnpm tsx
import * as readline from 'node:readline';

const BRAIN_URL = process.env.BRAIN_URL ?? 'http://localhost:3000';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let currentConversationId: string | undefined;

function prompt(): Promise<string> {
  const tag = currentConversationId ? ` ${currentConversationId.slice(0, 8)}` : '';
  return new Promise((resolve, reject) => {
    rl.question(`\x1b[36mbakerst${tag}>\x1b[0m `, resolve);
    rl.once('close', () => reject(new Error('EOF')));
  });
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BRAIN_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${BRAIN_URL}${path}`);
  return res.json();
}

async function pollStatus(jobId: string, maxWait = 60_000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const status = await get(`/jobs/${jobId}/status`);
    if ((status as any).status === 'completed' || (status as any).status === 'failed') {
      return status;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { error: 'timeout waiting for job' };
}

function printResult(status: any) {
  const color = status.status === 'completed' ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  const dim = '\x1b[2m';

  console.log(`${color}[${status.status}]${reset} ${dim}(${status.durationMs}ms, worker: ${status.workerId})${reset}`);
  if (status.result) {
    console.log(status.result);
  }
  if (status.error) {
    console.log(`${color}Error: ${status.error}${reset}`);
  }
}

async function chatStreamRequest(message: string) {
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  const res = await fetch(`${BRAIN_URL}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversationId: currentConversationId }),
  });

  if (!res.ok || !res.body) {
    const err = await res.text();
    console.log(`\x1b[31mError: ${err}\x1b[0m`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallCount = 0;
  let jobIds: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6);
      if (!json) continue;

      let event: any;
      try {
        event = JSON.parse(json);
      } catch {
        continue;
      }

      switch (event.type) {
        case 'delta':
          process.stdout.write(event.text);
          break;
        case 'thinking':
          toolCallCount++;
          process.stdout.write(`\n${dim}[running ${event.tool}...]${reset}`);
          break;
        case 'tool_result':
          process.stdout.write(`\r\x1b[K${dim}[${event.tool}: done]${reset}\n`);
          break;
        case 'done':
          currentConversationId = event.conversationId;
          jobIds = event.jobIds ?? [];
          toolCallCount = event.toolCallCount ?? toolCallCount;
          break;
        case 'error':
          console.log(`\n\x1b[31mError: ${event.message}\x1b[0m`);
          break;
      }
    }
  }

  // Final newline after streamed text
  process.stdout.write('\n');

  // Metadata footer
  const meta: string[] = [];
  if (toolCallCount > 0) meta.push(`${toolCallCount} tool call${toolCallCount > 1 ? 's' : ''}`);
  if (jobIds.length > 0) meta.push(`${jobIds.length} job${jobIds.length > 1 ? 's' : ''}`);
  if (meta.length > 0) {
    console.log(`${dim}(${meta.join(', ')})${reset}`);
  }
}

function printHelp() {
  console.log(`
\x1b[1mCommands:\x1b[0m
  <text>               Chat with the brain agent (default, streaming)
  chat <message>       Chat with the brain agent (explicit)
  new                  Start a new conversation
  ask <question>       Direct dispatch: agent job to Claude on worker
  run <command>        Direct dispatch: shell command on worker
  http <url>           Direct dispatch: HTTP request from worker
  status <jobId>       Check a job's status
  jobs                 List all tracked jobs
  conversations        List recent conversations
  ping                 Check brain health
  help                 Show this help
  exit                 Quit
`);
}

async function main() {
  console.log('\x1b[1mbakerst interactive CLI\x1b[0m');
  console.log(`Connected to ${BRAIN_URL}`);
  console.log('Type "help" for commands.\n');

  // Check connection
  try {
    await get('/ping');
    console.log(`\x1b[32mBrain is online.\x1b[0m\n`);
  } catch {
    console.log(`\x1b[31mWarning: cannot reach brain at ${BRAIN_URL}\x1b[0m`);
    console.log('Make sure port-forward is running: kubectl port-forward svc/brain 3000:3000 -n bakerst\n');
  }

  while (true) {
    let input: string;
    try {
      input = (await prompt()).trim();
    } catch {
      break;
    }
    if (!input) continue;

    const [cmd, ...rest] = input.split(' ');
    const arg = rest.join(' ');

    try {
      switch (cmd) {
        case 'chat': {
          if (!arg) { console.log('Usage: chat <message>'); break; }
          await chatStreamRequest(arg);
          break;
        }

        case 'new': {
          currentConversationId = undefined;
          console.log('\x1b[2mStarting new conversation.\x1b[0m');
          break;
        }

        case 'conversations': {
          const convos = await get('/conversations') as any[];
          if (convos.length === 0) {
            console.log('No conversations yet.');
          } else {
            const dim = '\x1b[2m';
            const reset = '\x1b[0m';
            for (const c of convos) {
              const active = c.id === currentConversationId ? ' \x1b[32m(active)\x1b[0m' : '';
              console.log(`${dim}${c.id.slice(0, 8)}${reset} ${c.title ?? '(untitled)'}  ${dim}${c.updated_at}${reset}${active}`);
            }
          }
          break;
        }

        case 'ask': {
          if (!arg) { console.log('Usage: ask <question>'); break; }
          const dispatched = await post('/webhook', { type: 'agent', job: arg });
          console.log(`\x1b[2mDispatched job ${(dispatched as any).jobId}, waiting...\x1b[0m`);
          const status = await pollStatus((dispatched as any).jobId);
          printResult(status);
          break;
        }

        case 'run': {
          if (!arg) { console.log('Usage: run <command>'); break; }
          const dispatched = await post('/webhook', { type: 'command', command: arg });
          console.log(`\x1b[2mDispatched job ${(dispatched as any).jobId}, waiting...\x1b[0m`);
          const status = await pollStatus((dispatched as any).jobId);
          printResult(status);
          break;
        }

        case 'http': {
          if (!arg) { console.log('Usage: http <url>'); break; }
          const dispatched = await post('/webhook', { type: 'http', url: arg });
          console.log(`\x1b[2mDispatched job ${(dispatched as any).jobId}, waiting...\x1b[0m`);
          const status = await pollStatus((dispatched as any).jobId);
          printResult(status);
          break;
        }

        case 'status': {
          if (!arg) { console.log('Usage: status <jobId>'); break; }
          const status = await get(`/jobs/${arg}/status`);
          printResult(status);
          break;
        }

        case 'jobs': {
          const jobs = await get('/jobs') as any[];
          if (jobs.length === 0) {
            console.log('No jobs tracked yet.');
          } else {
            const dim = '\x1b[2m';
            const reset = '\x1b[0m';
            for (const j of jobs) {
              const color = j.status === 'completed' ? '\x1b[32m' : j.status === 'failed' ? '\x1b[31m' : '\x1b[33m';
              const preview = j.result ? ` ${dim}${j.result.slice(0, 80)}${j.result.length > 80 ? '...' : ''}${reset}` : '';
              console.log(`${color}${j.status.padEnd(10)}${reset} ${dim}${j.jobId}${reset}${preview}`);
            }
          }
          break;
        }

        case 'ping': {
          const result = await get('/ping');
          console.log(JSON.stringify(result, null, 2));
          break;
        }

        case 'help':
          printHelp();
          break;

        case 'exit':
        case 'quit':
        case 'q':
          console.log('Bye!');
          rl.close();
          process.exit(0);

        default:
          // Bare text → chat with the brain agent (streaming)
          await chatStreamRequest(input);
      }
    } catch (err) {
      console.log(`\x1b[31mError: ${err instanceof Error ? err.message : err}\x1b[0m`);
    }

    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
