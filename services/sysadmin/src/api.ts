import express from 'express';
import type { Express, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { logger } from '@bakerst/shared';
import type { SysAdminAgent, AgentTurnResult } from './agent.js';
import type { SysAdminStateMachine } from './state-machine.js';
import type { ServerMessage, ClientMessage } from './types.js';

const log = logger.child({ module: 'sysadmin-api' });

/** Pending ask_user questions waiting for answers via WebSocket */
const pendingQuestions = new Map<string, {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}>();

/** Resolve an ask_user question (called from the ask_user tool) */
export function resolveQuestion(id: string, answer: string): void {
  const pending = pendingQuestions.get(id);
  if (pending) {
    pending.resolve(answer);
    pendingQuestions.delete(id);
  }
}

/** Active WebSocket connections */
let activeWs: WebSocket | null = null;

/** Send a message to the connected terminal client */
export function sendToTerminal(msg: ServerMessage): void {
  if (activeWs?.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify(msg));
  }
}

/**
 * Ask the user a question via WebSocket and wait for the answer.
 * Used by the ask_user tool.
 */
export function askUserViaWs(
  question: string,
  inputType: 'text' | 'secret' | 'choice',
  choices?: string[],
): Promise<string> {
  const id = randomUUID();

  return new Promise<string>((resolve, reject) => {
    pendingQuestions.set(id, { resolve, reject });
    sendToTerminal({ type: 'ask', id, question, inputType, choices });

    // Timeout after 10 minutes
    setTimeout(() => {
      if (pendingQuestions.has(id)) {
        pendingQuestions.delete(id);
        reject(new Error('User did not respond within 10 minutes'));
      }
    }, 600_000);
  });
}

export function createApi(
  agent: SysAdminAgent,
  stateMachine: SysAdminStateMachine,
): { app: Express; attachWebSocket: (server: Server) => void } {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/ping', (_req: Request, res: Response) => {
    res.json({ status: 'ok', state: stateMachine.state });
  });

  // Status
  app.get('/api/status', (_req: Request, res: Response) => {
    res.json({
      state: stateMachine.state,
      uptime: process.uptime(),
    });
  });

  // Chat endpoint (HTTP fallback for WebSocket)
  app.post('/api/chat', async (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    try {
      const result = await processMessage(agent, stateMachine, message);
      res.json({ response: result.response, state: stateMachine.state });
    } catch (err) {
      log.error({ err }, 'chat error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Serve the built-in terminal UI
  app.get('/', (_req: Request, res: Response) => {
    res.send(terminalHtml());
  });

  function attachWebSocket(server: Server): void {
    const wss = new WebSocketServer({ server, path: '/terminal' });

    wss.on('connection', (ws) => {
      log.info('terminal client connected');
      activeWs = ws;

      // Send current status
      sendToTerminal({ type: 'status', state: stateMachine.state });

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage;

          if (msg.type === 'answer') {
            resolveQuestion(msg.id, msg.value);
            return;
          }

          if (msg.type === 'chat') {
            sendToTerminal({ type: 'status', state: stateMachine.state });
            const result = await processMessage(agent, stateMachine, msg.message);
            sendToTerminal({ type: 'text', content: result.response });
            sendToTerminal({ type: 'status', state: stateMachine.state });
          }
        } catch (err) {
          log.error({ err }, 'websocket message error');
          sendToTerminal({ type: 'error', message: 'Processing error' });
        }
      });

      ws.on('close', () => {
        log.info('terminal client disconnected');
        if (activeWs === ws) activeWs = null;
      });
    });
  }

  return { app, attachWebSocket };
}

async function processMessage(
  agent: SysAdminAgent,
  stateMachine: SysAdminStateMachine,
  message: string,
): Promise<AgentTurnResult> {
  const result = await agent.chat(message);

  if (result.stateTransition) {
    stateMachine.transition(result.stateTransition);
  }

  return result;
}

/** Minimal terminal web UI — single HTML page */
function terminalHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baker Street SysAdmin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Menlo', 'Consolas', monospace; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  header { background: #16213e; padding: 12px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #0f3460; }
  header h1 { font-size: 16px; color: #e94560; }
  #state { font-size: 12px; padding: 2px 8px; border-radius: 4px; background: #0f3460; color: #7ec8e3; }
  #output { flex: 1; overflow-y: auto; padding: 16px 20px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; }
  #output .system { color: #7ec8e3; }
  #output .agent { color: #e0e0e0; }
  #output .error { color: #e94560; }
  #output .thinking { color: #666; font-style: italic; }
  #input-area { display: flex; padding: 12px 20px; background: #16213e; border-top: 1px solid #0f3460; gap: 8px; }
  #input-area input { flex: 1; background: #0f3460; border: 1px solid #333; color: #e0e0e0; padding: 8px 12px; border-radius: 4px; font-family: inherit; font-size: 14px; }
  #input-area button { background: #e94560; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-family: inherit; }
  #input-area button:hover { background: #c73e54; }
  .ask-box { background: #0f3460; border: 1px solid #e94560; border-radius: 8px; padding: 12px; margin: 8px 0; }
  .ask-box label { display: block; margin-bottom: 8px; color: #e94560; }
  .ask-box input, .ask-box select { background: #1a1a2e; border: 1px solid #333; color: #e0e0e0; padding: 6px 10px; border-radius: 4px; width: 100%; font-family: inherit; margin-bottom: 8px; }
  .ask-box button { background: #e94560; color: white; border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; }
  .ask-box .checkbox-group { margin-bottom: 8px; }
  .ask-box .checkbox-group label { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; color: #e0e0e0; cursor: pointer; font-size: 14px; }
  .ask-box .checkbox-group input[type="checkbox"] { accent-color: #e94560; width: 16px; height: 16px; }
  #input-area.disabled input { opacity: 0.4; pointer-events: none; }
  #input-area.disabled button { opacity: 0.4; pointer-events: none; }
  .waiting { color: #e94560; font-style: italic; padding: 4px 0; }
</style>
</head>
<body>
<header>
  <h1>Baker Street SysAdmin</h1>
  <span id="state">connecting...</span>
</header>
<div id="output"></div>
<div id="input-area">
  <input id="msg" type="text" placeholder="Type a message..." autofocus>
  <button id="send">Send</button>
</div>
<script>
const output = document.getElementById('output');
const msgInput = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const inputArea = document.getElementById('input-area');
const stateEl = document.getElementById('state');
let ws;
let pendingAsk = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/terminal');
  ws.onopen = () => { append('Connected.', 'system'); };
  ws.onclose = () => { append('Disconnected. Reconnecting...', 'error'); setTimeout(connect, 2000); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'text') { removeWaiting(); append(msg.content, 'agent'); setInputDisabled(false); }
    else if (msg.type === 'status') stateEl.textContent = msg.state;
    else if (msg.type === 'thinking') append('Using ' + msg.tool + '...', 'thinking');
    else if (msg.type === 'error') { removeWaiting(); append('Error: ' + msg.message, 'error'); setInputDisabled(false); }
    else if (msg.type === 'ask') { removeWaiting(); showAsk(msg); }
  };
}

function setInputDisabled(disabled) {
  pendingAsk = disabled;
  if (disabled) inputArea.classList.add('disabled');
  else inputArea.classList.remove('disabled');
}

function removeWaiting() {
  const el = output.querySelector('.waiting:last-child');
  if (el) el.remove();
}

function append(text, cls) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

function submitAnswer(id, value, box) {
  ws.send(JSON.stringify({ type: 'answer', id, value }));
  box.remove();
  setInputDisabled(false);
  append('Working...', 'waiting');
}

function showAsk(msg) {
  setInputDisabled(true);
  const box = document.createElement('div');
  box.className = 'ask-box';
  const label = document.createElement('label');
  label.textContent = msg.question;
  box.appendChild(label);

  if (msg.inputType === 'choice' && msg.choices) {
    // Use checkboxes for multi-select
    const group = document.createElement('div');
    group.className = 'checkbox-group';
    msg.choices.forEach(c => {
      const row = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = c;
      row.appendChild(cb);
      row.appendChild(document.createTextNode(c));
      group.appendChild(row);
    });
    box.appendChild(group);
    const btn = document.createElement('button');
    btn.textContent = 'Submit';
    btn.onclick = () => {
      const selected = Array.from(group.querySelectorAll('input:checked')).map(cb => cb.value);
      submitAnswer(msg.id, selected.length > 0 ? selected.join(', ') : 'none', box);
    };
    box.appendChild(btn);
  } else {
    const input = document.createElement('input');
    input.type = msg.inputType === 'secret' ? 'password' : 'text';
    input.placeholder = msg.inputType === 'secret' ? '••••••••' : 'Type your answer...';
    box.appendChild(input);
    const btn = document.createElement('button');
    btn.textContent = 'Submit';
    const submit = () => { submitAnswer(msg.id, input.value, box); };
    btn.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    box.appendChild(btn);
    setTimeout(() => input.focus(), 50);
  }

  output.appendChild(box);
  output.scrollTop = output.scrollHeight;
}

function send() {
  if (pendingAsk) return;
  const text = msgInput.value.trim();
  if (!text) return;
  append('> ' + text, 'system');
  ws.send(JSON.stringify({ type: 'chat', message: text }));
  msgInput.value = '';
  setInputDisabled(true);
  append('Working...', 'waiting');
}

sendBtn.onclick = send;
msgInput.onkeydown = (e) => { if (e.key === 'Enter') send(); };
connect();
</script>
</body>
</html>`;
}
