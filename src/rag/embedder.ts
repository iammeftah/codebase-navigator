/**
 * embedder.ts
 *
 * Turns FileEntry records into text chunks and fetches embedding vectors.
 * If the provider doesn't support embeddings (e.g. Groq chat models, Anthropic),
 * it silently falls back to a local TF-IDF fingerprint so RAG still works
 * via keyword search — no crash, no extra config needed.
 */

import { FileEntry } from '../analyzer/types';
import { ModelProfile } from '../sidebar/modelManager';

export interface EmbedResult {
  relativePath: string;
  text: string;
  vector: number[];
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function embedFiles(
  files: FileEntry[],
  profile: ModelProfile,
  apiKey: string,
  onProgress?: (msg: string) => void,
): Promise<EmbedResult[]> {
  const chunks = files.map(fileToChunk);
  const texts  = chunks.map(c => c.text);

  // Anthropic has no embeddings endpoint — go straight to TF-IDF
  if (profile.apiFormat === 'anthropic') {
    onProgress?.('Anthropic provider — using local TF-IDF vectors.');
    return chunks.map(c => ({ ...c, vector: tfidfVector(c.text, texts) }));
  }

  if (profile.apiFormat === 'ollama') {
    return embedWithFallback(
      () => embedOllama(chunks, profile.baseUrl, profile.label, onProgress),
      chunks, texts, onProgress,
    );
  }

  // OpenAI-compat — try the API, fall back to TF-IDF on any error
  return embedWithFallback(
    () => embedOpenAI(chunks, profile.baseUrl, profile.label, apiKey, onProgress),
    chunks, texts, onProgress,
  );
}

export async function embedQuery(
  query: string,
  profile: ModelProfile,
  apiKey: string,
): Promise<number[]> {
  if (profile.apiFormat === 'anthropic') {
    return tfidfVector(query, []);
  }
  if (profile.apiFormat === 'ollama') {
    try {
      const res = await embedOllama([{ relativePath: '__query__', text: query }], profile.baseUrl, profile.label);
      return res[0]?.vector ?? [];
    } catch {
      return tfidfVector(query, []);
    }
  }
  try {
    const res = await embedOpenAI([{ relativePath: '__query__', text: query }], profile.baseUrl, profile.label, apiKey);
    return res[0]?.vector ?? [];
  } catch {
    return tfidfVector(query, []);
  }
}

// ── Fallback wrapper ─────────────────────────────────────────────────────────
// Runs the real embed fn; if it throws for any reason (400, 404, network, etc.)
// silently produces TF-IDF vectors for the whole batch instead.

async function embedWithFallback(
  fn: () => Promise<EmbedResult[]>,
  chunks: { relativePath: string; text: string }[],
  corpus: string[],
  onProgress?: (msg: string) => void,
): Promise<EmbedResult[]> {
  try {
    return await fn();
  } catch {
    onProgress?.('Model does not support embeddings — using keyword search instead.');
    return chunks.map(c => ({ ...c, vector: tfidfVector(c.text, corpus) }));
  }
}

// ── File → text chunk ────────────────────────────────────────────────────────

function fileToChunk(file: FileEntry): { relativePath: string; text: string } {
  const parts: string[] = [
    `File: ${file.relativePath}`,
    `Language: ${file.language}`,
    `Layer: ${file.layer}`,
  ];
  if (file.exports.length > 0) {
    parts.push(`Exports: ${file.exports.slice(0, 10).join(', ')}`);
  }
  if (file.imports.length > 0) {
    parts.push(`Imports: ${file.imports.slice(0, 8).join(', ')}`);
  }
  return { relativePath: file.relativePath, text: parts.join('\n') };
}

// ── OpenAI-compat embeddings ─────────────────────────────────────────────────

const BATCH_SIZE = 64;

async function embedOpenAI(
  chunks: { relativePath: string; text: string }[],
  baseUrl: string,
  model: string,
  apiKey: string,
  onProgress?: (msg: string) => void,
): Promise<EmbedResult[]> {
  const url     = baseUrl.replace(/\/$/, '') + '/v1/embeddings';
  const results: EmbedResult[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    onProgress?.(`Embedding files ${i + 1}–${Math.min(i + BATCH_SIZE, chunks.length)} of ${chunks.length}…`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: batch.map(c => c.text),
        encoding_format: 'float',
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
    }

    const data = await res.json() as { data: { index: number; embedding: number[] }[] };
    for (const item of data.data) {
      results.push({
        relativePath: batch[item.index].relativePath,
        text:         batch[item.index].text,
        vector:       item.embedding,
      });
    }
  }

  return results;
}

// ── Ollama embeddings ────────────────────────────────────────────────────────

async function embedOllama(
  chunks: { relativePath: string; text: string }[],
  baseUrl: string,
  model: string,
  onProgress?: (msg: string) => void,
): Promise<EmbedResult[]> {
  const url     = baseUrl.replace(/\/$/, '') + '/api/embed';
  const results: EmbedResult[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    onProgress?.(`Embedding files ${i + 1}–${Math.min(i + BATCH_SIZE, chunks.length)} of ${chunks.length}…`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch.map(c => c.text) }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      throw new Error(err?.error ?? `HTTP ${res.status}`);
    }

    const data = await res.json() as { embeddings: number[][] };
    for (let j = 0; j < batch.length; j++) {
      results.push({
        relativePath: batch[j].relativePath,
        text:         batch[j].text,
        vector:       data.embeddings[j],
      });
    }
  }

  return results;
}

// ── TF-IDF fallback ──────────────────────────────────────────────────────────

const TFIDF_DIM = 512;

function tokenise(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9_/]/g, ' ').split(/\s+/).filter(Boolean);
}

function tfidfVector(text: string, corpus: string[]): number[] {
  const tokens = tokenise(text);
  const tf: Record<string, number> = {};
  for (const t of tokens) { tf[t] = (tf[t] ?? 0) + 1; }

  const vec: Record<string, number> = {};
  if (corpus.length === 0) {
    Object.assign(vec, tf);
  } else {
    for (const [term, freq] of Object.entries(tf)) {
      const df  = corpus.filter(doc => doc.includes(term)).length;
      const idf = Math.log((corpus.length + 1) / (df + 1)) + 1;
      vec[term] = freq * idf;
    }
  }

  const out = new Array<number>(TFIDF_DIM).fill(0);
  for (const [term, score] of Object.entries(vec)) {
    out[hashSlot(term, TFIDF_DIM)] += score;
  }
  return out;
}

function hashSlot(s: string, size: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h % size;
}