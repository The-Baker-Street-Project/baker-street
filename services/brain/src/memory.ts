import { randomUUID, createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { logger, CircuitBreaker } from '@bakerst/shared';

const log = logger.child({ module: 'memory' });

const voyageBreaker = new CircuitBreaker({
  name: 'voyage-ai',
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  onStateChange: (from, to) => {
    log.warn({ from, to }, 'voyage AI circuit breaker state change');
  },
});

const COLLECTION = 'memories';
const VECTOR_DIM = 1024;
const DEDUP_THRESHOLD = 0.92;
const MIN_RELEVANCE_SCORE = 0.3;

export interface Memory {
  id: string;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult extends Memory {
  score: number;
}

export interface MemoryService {
  store(content: string, category?: string): Promise<Memory>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  remove(id: string): Promise<void>;
  list(category?: string, limit?: number): Promise<Memory[]>;
}

async function embed(text: string, inputType: 'document' | 'query'): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not set');

  return voyageBreaker.execute(async () => {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: [text],
        model: 'voyage-3.5-lite',
        input_type: inputType,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Voyage API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  });
}

function contentHash(content: string): string {
  return createHash('md5').update(content.trim().toLowerCase()).digest('hex');
}

/** Returns a stub MemoryService that does nothing (used when memory feature is disabled). */
export function createNoOpMemoryService(): MemoryService {
  const now = new Date().toISOString();
  return {
    async store(_content: string, category = 'general'): Promise<Memory> {
      return { id: 'noop', content: _content, category, created_at: now, updated_at: now };
    },
    async search(_query: string, _limit?: number): Promise<MemorySearchResult[]> {
      return [];
    },
    async remove(_id: string): Promise<void> {},
    async list(_category?: string, _limit?: number): Promise<Memory[]> {
      return [];
    },
  };
}

export async function initMemory(): Promise<MemoryService> {
  const url = process.env.QDRANT_URL ?? 'http://localhost:6333';
  const client = new QdrantClient({ url });

  // Ensure collection exists
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);
  if (!exists) {
    await client.createCollection(COLLECTION, {
      vectors: { size: VECTOR_DIM, distance: 'Cosine' },
    });
    log.info('created qdrant collection: %s', COLLECTION);
  } else {
    log.info('qdrant collection already exists: %s', COLLECTION);
  }

  async function store(content: string, category = 'general'): Promise<Memory> {
    const vector = await embed(content, 'document');

    // Dedup check: search for very similar existing memories
    const similar = await client.search(COLLECTION, {
      vector,
      limit: 1,
      score_threshold: DEDUP_THRESHOLD,
    });

    if (similar.length > 0) {
      const existing = similar[0];
      const existingPayload = existing.payload as Record<string, unknown>;
      log.info(
        { existingId: existing.id, score: existing.score },
        'near-duplicate found, updating existing memory',
      );

      const now = new Date().toISOString();
      await client.upsert(COLLECTION, {
        points: [
          {
            id: existing.id as string,
            vector,
            payload: {
              content,
              category,
              created_at: existingPayload.created_at as string,
              updated_at: now,
              content_hash: contentHash(content),
            },
          },
        ],
      });

      return {
        id: existing.id as string,
        content,
        category,
        created_at: existingPayload.created_at as string,
        updated_at: now,
      };
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    await client.upsert(COLLECTION, {
      points: [
        {
          id,
          vector,
          payload: {
            content,
            category,
            created_at: now,
            updated_at: now,
            content_hash: contentHash(content),
          },
        },
      ],
    });

    log.info({ id, category }, 'stored new memory');
    return { id, content, category, created_at: now, updated_at: now };
  }

  async function search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const vector = await embed(query, 'query');
    const results = await client.search(COLLECTION, {
      vector,
      limit,
      score_threshold: MIN_RELEVANCE_SCORE,
    });

    return results.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return {
        id: r.id as string,
        content: p.content as string,
        category: (p.category as string) ?? 'general',
        created_at: p.created_at as string,
        updated_at: p.updated_at as string,
        score: r.score,
      };
    });
  }

  async function remove(id: string): Promise<void> {
    await client.delete(COLLECTION, { points: [id] });
    log.info({ id }, 'deleted memory');
  }

  async function list(category?: string, limit = 50): Promise<Memory[]> {
    const filter = category
      ? { must: [{ key: 'category', match: { value: category } }] }
      : undefined;

    const result = await client.scroll(COLLECTION, {
      filter,
      limit,
      with_payload: true,
    });

    return result.points.map((p) => {
      const payload = p.payload as Record<string, unknown>;
      return {
        id: p.id as string,
        content: payload.content as string,
        category: (payload.category as string) ?? 'general',
        created_at: payload.created_at as string,
        updated_at: payload.updated_at as string,
      };
    });
  }

  return { store, search, remove, list };
}
