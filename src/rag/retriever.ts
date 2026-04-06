/**
 * retriever.ts
 *
 * Given a user question and a populated VectorStore, returns the
 * top-k most relevant FileEntry records to inject into the prompt.
 *
 * Also handles the "always include" set — files that are so structurally
 * important (routes, main entry, config) that they should always be present
 * regardless of similarity score.
 */

import { FileEntry, ProjectIndex } from '../analyzer/types';
import { ModelProfile } from '../sidebar/modelManager';
import { VectorStore } from './vectorStore';
import { embedQuery } from './embedder';

// Layers that are always injected regardless of RAG score
// (they give the AI essential orientation for any question)
const ALWAYS_INCLUDE_LAYERS = new Set(['routes', 'providers', 'config']);
const ALWAYS_INCLUDE_MAX    = 6; // cap so we don't bloat the prompt

export interface RetrievalResult {
  files: FileEntry[];
  /** true = full RAG retrieval; false = query embed failed, fell back to layer heuristic */
  usedEmbeddings: boolean;
}

/**
 * Main retrieval entry point.
 *
 * @param question   Raw user question
 * @param index      Full project index (used for always-include + fallback)
 * @param store      Populated VectorStore
 * @param profile    Active model profile (for embedding API call)
 * @param apiKey     API key for the profile
 * @param topK       How many semantically-similar files to retrieve (default 8)
 */
export async function retrieve(
  question: string,
  index: ProjectIndex,
  store: VectorStore,
  profile: ModelProfile,
  apiKey: string,
  topK = 8,
): Promise<RetrievalResult> {

  // ── Always-include set ───────────────────────────────────────────────────
  const alwaysInclude = index.files
    .filter(f => ALWAYS_INCLUDE_LAYERS.has(f.layer))
    .slice(0, ALWAYS_INCLUDE_MAX);

  const alwaysPaths = new Set(alwaysInclude.map(f => f.relativePath));

  // ── Semantic retrieval ───────────────────────────────────────────────────
  let semanticFiles: FileEntry[] = [];
  let usedEmbeddings = false;

  try {
    const queryVec = await embedQuery(question, profile, apiKey);

    if (queryVec.length > 0) {
      const hits = store.search(queryVec, topK + ALWAYS_INCLUDE_MAX);
      const hitPaths = hits.map(h => h.relativePath);

      // Map back to full FileEntry objects (store only keeps the text chunk)
      const fileByPath = new Map(index.files.map(f => [f.relativePath, f]));
      semanticFiles = hitPaths
        .map(p => fileByPath.get(p))
        .filter((f): f is FileEntry => !!f && !alwaysPaths.has(f.relativePath))
        .slice(0, topK);

      usedEmbeddings = true;
    }
  } catch {
    // Embedding call failed — fall through to heuristic fallback
  }

  // ── Heuristic fallback (if embeddings unavailable) ───────────────────────
  if (!usedEmbeddings) {
    semanticFiles = heuristicFallback(question, index, alwaysPaths, topK);
  }

  // ── Merge & deduplicate ──────────────────────────────────────────────────
  const merged = [...alwaysInclude, ...semanticFiles];
  const seen   = new Set<string>();
  const unique = merged.filter(f => {
    if (seen.has(f.relativePath)) { return false; }
    seen.add(f.relativePath);
    return true;
  });

  return { files: unique, usedEmbeddings };
}

// ── Heuristic fallback ───────────────────────────────────────────────────────
//
// When embedding is unavailable, score files by keyword overlap with the question.
// Better than nothing and completely free.

function heuristicFallback(
  question: string,
  index: ProjectIndex,
  exclude: Set<string>,
  topK: number,
): FileEntry[] {
  const qTokens = tokenSet(question);
  if (qTokens.size === 0) { return index.files.slice(0, topK); }

  return index.files
    .filter(f => !exclude.has(f.relativePath))
    .map(f => ({
      file: f,
      score: scoreFile(f, qTokens),
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => x.file);
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(t => t.length > 2)
  );
}

function scoreFile(file: FileEntry, qTokens: Set<string>): number {
  const pathTokens = tokenSet(file.relativePath);
  const exportTokens = tokenSet(file.exports.join(' '));
  const importTokens = tokenSet(file.imports.join(' '));

  let score = 0;
  for (const t of qTokens) {
    if (pathTokens.has(t))   { score += 3; } // path match is strongest signal
    if (exportTokens.has(t)) { score += 2; }
    if (importTokens.has(t)) { score += 1; }
  }
  return score;
}
