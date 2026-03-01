import type { McpServer } from '@bakerst/extension-sdk';
import { z } from 'zod';

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const MAX_BODY = 8192;

interface PerplexityMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PerplexityCitation {
  url: string;
}

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  citations?: (string | PerplexityCitation)[];
}

function truncate(text: string, max = MAX_BODY): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length} chars total)`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

async function callPerplexity(
  apiKey: string,
  model: string,
  messages: PerplexityMessage[],
): Promise<{ text: string; citations?: string[] }> {
  const res = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perplexity API ${res.status}: ${body}`);
  }

  const data = await res.json() as PerplexityResponse;
  const text = data.choices?.[0]?.message?.content ?? '';
  const citations = data.citations?.map((c) =>
    typeof c === 'string' ? c : c.url,
  );

  return { text, citations };
}

function formatWithCitations(text: string, citations?: string[]): string {
  let result = text;
  if (citations && citations.length > 0) {
    result += '\n\n--- Sources ---';
    for (let i = 0; i < citations.length; i++) {
      result += `\n[${i + 1}] ${citations[i]}`;
    }
  }
  return result;
}

export function registerPerplexityTools(server: McpServer): void {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn('[toolbox] PERPLEXITY_API_KEY not set — Perplexity tools disabled');
    return;
  }

  server.tool(
    'perplexity_search',
    'Quick factual web search using Perplexity AI. Returns a concise answer with source citations. Good for current events, facts, and quick lookups.',
    { query: z.string() },
    async ({ query }: { query: string }) => {
      try {
        const { text, citations } = await callPerplexity(apiKey, 'sonar', [
          { role: 'system', content: 'Be precise and concise. Provide factual answers with sources.' },
          { role: 'user', content: query },
        ]);
        return ok(truncate(formatWithCitations(text, citations)));
      } catch (e) {
        return err(`Perplexity search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'perplexity_research',
    'Deep research using Perplexity AI with comprehensive citations. Takes longer but provides thorough, well-sourced analysis. Good for complex topics requiring multiple sources.',
    { query: z.string(), system_prompt: z.string().optional() },
    async ({ query, system_prompt }: { query: string; system_prompt?: string }) => {
      try {
        const { text, citations } = await callPerplexity(apiKey, 'sonar-deep-research', [
          { role: 'system', content: system_prompt ?? 'Provide a thorough, well-researched analysis with citations.' },
          { role: 'user', content: query },
        ]);
        return ok(truncate(formatWithCitations(text, citations)));
      } catch (e) {
        return err(`Perplexity research failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  console.log('[toolbox] Perplexity tools registered (2 tools)');
}
