import { FileEntry, ProjectIndex } from '../analyzer/types';

// ── Detect whether a message is conversational or code-related ───────────────
//
// Used to skip RAG injection for casual messages like "hello", "thanks",
// "what can you do?" — injecting file context into those just confuses the model.

const CONVERSATIONAL_PATTERNS = [
  /^(hi|hello|hey|sup|yo|hiya|howdy)\b/i,
  /^(thanks|thank you|thx|cheers|appreciate)/i,
  /^(how are you|how's it going|what's up|whats up)/i,
  /^(good morning|good evening|good afternoon|good night)/i,
  /^(bye|goodbye|see you|cya|later)\b/i,
  /^(ok|okay|got it|i see|understood|makes sense|nice|cool|great|awesome|perfect)/i,
  /^(what can you do|what are you|who are you|help me understand you)/i,
  /^(lol|haha|hehe|😂|👍|💯)/i,
];

export function isConversational(question: string): boolean {
  const q = question.trim();
  // Short messages with no file/code signals are likely conversational
  const hasCodeSignal = /\.|\/|->|=>|import|export|function|class|const|let|var|def |return |if\s*\(/.test(q);
  if (hasCodeSignal) { return false; }
  if (q.length < 60 && CONVERSATIONAL_PATTERNS.some(p => p.test(q))) { return true; }
  if (q.length < 25 && !hasCodeSignal) { return true; } // very short, no code = probably chat
  return false;
}

// ── Global system prompt ─────────────────────────────────────────────────────

export function buildSystemPrompt(index: ProjectIndex): string {
  const layerSummary = Object.entries(index.layers)
    .filter(([, files]) => files.length > 0)
    .map(([layer, files]) =>
      `  ${layer} (${files.length} files): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` … +${files.length - 5} more` : ''}`
    )
    .join('\n');

  return `You are a smart, friendly coding assistant embedded in VS Code via the "Codebase Navigator" extension. You help developers understand, navigate, and improve their codebase.

## Your personality
- Warm and human — you can hold a normal conversation, say hello back, answer casual questions
- Direct and concise when it comes to code — developers don't want fluff
- Honest — if you haven't seen a file's contents, say so rather than guessing
- Proactive — if you spot an issue or a better approach, mention it

## Project you're helping with
- Root: ${index.root}
- Framework: ${index.framework}
- Total human-authored files indexed: ${index.totalFiles}

## Architectural layers
${layerSummary}

## When answering code questions
- A "## Relevant files" section will appear in the user's message — those are the most likely files to answer the question, focus on them first
- Always wrap file paths in backticks: \`app/Http/Controllers/UserController.php\`
- If the answer isn't in the retrieved files, say so and suggest where else to look
- For "what breaks if I change X" questions, list all files that import or depend on it

## When the user is just chatting
- Respond naturally and warmly, like a helpful colleague
- You don't need to mention files or code unless it's relevant
- Keep it short and conversational
`;
}

// ── Per-question RAG context injection ──────────────────────────────────────
//
// Skips file injection entirely for conversational messages.
// For code questions, prepends the retrieved file summaries to the user turn.

export function buildRagUserMessage(
  question: string,
  retrievedFiles: FileEntry[],
  usedEmbeddings: boolean,
): string {
  // Don't pollute casual messages with file context
  if (retrievedFiles.length === 0 || isConversational(question)) {
    return question;
  }

  const fileBlock = retrievedFiles.map(f => {
    const lines: string[] = [`### \`${f.relativePath}\``];
    lines.push(`- Layer: ${f.layer} | Language: ${f.language}`);
    if (f.exports.length > 0) {
      lines.push(`- Exports: ${f.exports.slice(0, 12).join(', ')}`);
    }
    if (f.imports.length > 0) {
      lines.push(`- Imports: ${f.imports.slice(0, 8).join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  const retrievalNote = usedEmbeddings
    ? `(${retrievedFiles.length} files retrieved via semantic search)`
    : `(${retrievedFiles.length} files retrieved via keyword heuristic — embeddings unavailable)`;

  return `## Relevant files ${retrievalNote}

${fileBlock}

---

## Question
${question}`;
}

// ── History trimmer ──────────────────────────────────────────────────────────
//
// Keeps the most recent messages within a safe token budget.
// RAG context makes each message larger, so we use a tighter default (16k chars).

export function trimHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxChars = 16_000,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  let total = 0;
  const trimmed: typeof history = [];
  for (let i = history.length - 1; i >= 0; i--) {
    total += history[i].content.length;
    if (total > maxChars) { break; }
    trimmed.unshift(history[i]);
  }
  return trimmed;
}