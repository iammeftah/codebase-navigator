/**
 * In-memory vector store with cosine similarity search.
 * No external DB — vectors live in RAM, rebuilt on each workspace analysis.
 *
 * Why cosine similarity and not dot product?
 * Embedding vectors from OpenAI-compat APIs are L2-normalised, so cosine ≡ dot
 * product — but we normalise ourselves here to be safe with any provider.
 */

export interface VectorEntry {
  /** Relative file path — used as the stable key */
  relativePath: string;
  /** The text chunk that was embedded (used for debugging / display) */
  text: string;
  /** Raw embedding vector */
  vector: number[];
}

export class VectorStore {
  private entries: VectorEntry[] = [];

  // ── Write ────────────────────────────────────────────────────────────────

  clear(): void {
    this.entries = [];
  }

  add(entry: VectorEntry): void {
    // Normalise on insert so query-time math is just a dot product
    this.entries.push({ ...entry, vector: normalise(entry.vector) });
  }

  addMany(entries: VectorEntry[]): void {
    for (const e of entries) { this.add(e); }
  }

  get size(): number { return this.entries.length; }

  // ── Read ─────────────────────────────────────────────────────────────────

  /**
   * Returns the top-k most similar entries to the query vector.
   * @param queryVector  Raw (un-normalised) query embedding
   * @param k            Number of results to return (default 8)
   * @param minScore     Minimum similarity threshold 0–1 (default 0.25)
   */
  search(queryVector: number[], k = 8, minScore = 0.25): VectorEntry[] {
    const qNorm = normalise(queryVector);

    const scored = this.entries
      .map(e => ({ entry: e, score: dot(qNorm, e.vector) }))
      .filter(x => x.score >= minScore)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, k).map(x => x.entry);
  }
}

// ── Math helpers ────────────────────────────────────────────────────────────

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; }
  return s;
}

function normalise(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (mag === 0) { return v; }
  return v.map(x => x / mag);
}