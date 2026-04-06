import * as vscode from 'vscode';

export interface ModelProfile {
  id: string;       // stable ID, never changes
  label: string;    // e.g. "llama-3.3-70b-versatile"  (user-editable)
  baseUrl: string;  // e.g. "https://api.groq.com/openai"
  apiFormat: 'openai' | 'anthropic' | 'ollama';
}

const PROFILES_KEY = 'codebaseNavigator.modelProfiles2';
const KEY_PREFIX   = 'codebaseNavigator.key.';

// ── Built-in default: Groq + llama-3.3-70b-versatile (free tier) ─────────────
// This profile is always present. The user cannot delete it, only update its key.
export const DEFAULT_GROQ_ID = 'builtin-groq-llama';

export const DEFAULT_GROQ_PROFILE: ModelProfile = {
  id:        DEFAULT_GROQ_ID,
  label:     'llama-3.3-70b-versatile',
  baseUrl:   'https://api.groq.com/openai',
  apiFormat: 'openai',
};

// ── Streaming callback type ───────────────────────────────────────────────────
// Called with each text chunk as it arrives from the provider.
// When the stream is done, called once more with null.
export type StreamCallback = (chunk: string | null) => void;

export class ModelManager {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento
  ) {}

  // ── Called once on extension activate ────────────────────────────────────
  // Ensures the built-in Groq profile is always in the list (idempotent).
  async ensureDefaults(): Promise<void> {
    const profiles = this.getProfiles();
    if (!profiles.find(p => p.id === DEFAULT_GROQ_ID)) {
      await this.state.update(PROFILES_KEY, [DEFAULT_GROQ_PROFILE, ...profiles]);
    }
  }

  // Save / retrieve the Groq key independently (for the inline key field)
  async saveGroqKey(key: string): Promise<void> {
    await this.secrets.store(KEY_PREFIX + DEFAULT_GROQ_ID, key);
  }

  async getGroqKey(): Promise<string> {
    return (await this.secrets.get(KEY_PREFIX + DEFAULT_GROQ_ID)) ?? '';
  }

  // ── Profile CRUD ─────────────────────────────────────────────────────────

  getProfiles(): ModelProfile[] {
    return this.state.get<ModelProfile[]>(PROFILES_KEY, []);
  }

  async saveProfiles(profiles: ModelProfile[]): Promise<void> {
    await this.state.update(PROFILES_KEY, profiles);
  }

  async addProfile(profile: ModelProfile, apiKey: string): Promise<void> {
    const profiles = this.getProfiles();
    profiles.push(profile);
    await this.state.update(PROFILES_KEY, profiles);
    if (apiKey) { await this.secrets.store(KEY_PREFIX + profile.id, apiKey); }
  }

  async updateProfile(updated: ModelProfile, newApiKey?: string): Promise<void> {
    const profiles = this.getProfiles().map(p => p.id === updated.id ? updated : p);
    await this.state.update(PROFILES_KEY, profiles);
    if (newApiKey !== undefined && newApiKey !== '') {
      await this.secrets.store(KEY_PREFIX + updated.id, newApiKey);
    }
  }

  async removeProfile(profileId: string): Promise<void> {
    if (profileId === DEFAULT_GROQ_ID) { return; } // built-in — cannot be removed
    const profiles = this.getProfiles().filter(p => p.id !== profileId);
    await this.state.update(PROFILES_KEY, profiles);
    await this.secrets.delete(KEY_PREFIX + profileId);
  }

  async getApiKey(profileId: string): Promise<string> {
    return (await this.secrets.get(KEY_PREFIX + profileId)) ?? '';
  }

  // ── Provider-agnostic streaming chat ─────────────────────────────────────
  //
  // `onChunk` is called with each text fragment as it arrives.
  // When the stream ends normally, `onChunk(null)` is called once.
  // On error, the promise rejects — the caller should catch and signal the UI.
  //
  // Returns the full accumulated text (convenient for saving to history).

  async chatStream(
    profileId: string,
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    onChunk: StreamCallback,
  ): Promise<string> {
    const profile = this.getProfiles().find(p => p.id === profileId);
    if (!profile) { throw new Error('Model profile not found.'); }

    const apiKey = await this.getApiKey(profileId);

    if (profile.apiFormat === 'anthropic') {
      return this._streamAnthropic(profile, apiKey, systemPrompt, messages, onChunk);
    } else if (profile.apiFormat === 'ollama') {
      return this._streamOllama(profile, systemPrompt, messages, onChunk);
    } else {
      return this._streamOpenAI(profile, apiKey, systemPrompt, messages, onChunk);
    }
  }

  // ── OpenAI-compatible streaming ───────────────────────────────────────────
  // Works for: OpenAI, Groq, OpenRouter, Gemini (openai-compat), custom

  private async _streamOpenAI(
    profile: ModelProfile,
    apiKey: string,
    system: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: StreamCallback,
  ): Promise<string> {
    const url = profile.baseUrl.replace(/\/$/, '') + '/v1/chat/completions';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: profile.label,
        max_tokens: 2048,
        stream: true,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });

    if (!res.ok) {
      // Non-streaming error: parse JSON body for a useful message
      const err = await res.json().catch(() => ({})) as any;
      throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
    }

    // SSE: each line is "data: {...}" or "data: [DONE]"
    return this._consumeSSE(res, onChunk, (raw) => {
      const parsed = JSON.parse(raw);
      return parsed.choices?.[0]?.delta?.content ?? null;
    });
  }

  // ── Anthropic streaming ───────────────────────────────────────────────────
  // Uses Anthropic's SSE format: event types are "content_block_delta" etc.

  private async _streamAnthropic(
    profile: ModelProfile,
    apiKey: string,
    system: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: StreamCallback,
  ): Promise<string> {
    const url = profile.baseUrl.replace(/\/$/, '') + '/v1/messages';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: profile.label,
        max_tokens: 2048,
        stream: true,
        system,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
    }

    // Anthropic SSE lines look like:
    //   event: content_block_delta
    //   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
    //
    // We only need the "data:" lines; the "event:" lines tell us the type
    // but the type is also in the data JSON itself.
    return this._consumeSSE(res, onChunk, (raw) => {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        return parsed.delta.text ?? null;
      }
      return null; // ping / other event types → ignore
    });
  }

  // ── Ollama streaming ──────────────────────────────────────────────────────
  // Ollama sends newline-delimited JSON (NDJSON), not SSE.

  private async _streamOllama(
    profile: ModelProfile,
    system: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: StreamCallback,
  ): Promise<string> {
    const url = profile.baseUrl.replace(/\/$/, '') + '/api/chat';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: profile.label,
        stream: true,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      throw new Error(err?.error ?? `HTTP ${res.status}`);
    }

    // Ollama: each line is a JSON object { message: { content: "..." }, done: bool }
    return this._consumeNDJSON(res, onChunk, (parsed) => {
      if (parsed.done) { return null; }
      return parsed.message?.content ?? null;
    });
  }

  // ── SSE stream reader (OpenAI + Anthropic) ────────────────────────────────
  //
  // Reads the response body line by line.
  // `extract(rawDataStr)` pulls the text delta out of each parsed JSON object.
  // Returns null to signal "skip this line" (pings, non-text events).

  private async _consumeSSE(
    res: Response,
    onChunk: StreamCallback,
    extract: (raw: string) => string | null,
  ): Promise<string> {
    if (!res.body) { throw new Error('No response body for streaming.'); }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';
    let   full    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buf += decoder.decode(value, { stream: true });

      // Process every complete line in the buffer
      const lines = buf.split('\n');
      buf = lines.pop() ?? ''; // last element may be incomplete — keep it

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') { continue; }
        if (!trimmed.startsWith('data:')) { continue; } // skip "event:" lines

        const raw = trimmed.slice('data:'.length).trim();
        try {
          const chunk = extract(raw);
          if (chunk) {
            full += chunk;
            onChunk(chunk);
          }
        } catch {
          // Malformed JSON in one chunk — skip it, don't abort the whole stream
        }
      }
    }

    // Flush any remaining buffer content
    if (buf.trim() && buf.trim() !== 'data: [DONE]') {
      const trimmed = buf.trim();
      if (trimmed.startsWith('data:')) {
        const raw = trimmed.slice('data:'.length).trim();
        try {
          const chunk = extract(raw);
          if (chunk) { full += chunk; onChunk(chunk); }
        } catch { /* ignore */ }
      }
    }

    onChunk(null); // signal: stream complete
    return full;
  }

  // ── NDJSON stream reader (Ollama) ─────────────────────────────────────────

  private async _consumeNDJSON(
    res: Response,
    onChunk: StreamCallback,
    extract: (parsed: any) => string | null,
  ): Promise<string> {
    if (!res.body) { throw new Error('No response body for streaming.'); }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';
    let   full    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const parsed = JSON.parse(trimmed);
          const chunk  = extract(parsed);
          if (chunk === null && parsed.done) {
            // Ollama signals done via { done: true } — stop here
            onChunk(null);
            return full;
          }
          if (chunk) {
            full += chunk;
            onChunk(chunk);
          }
        } catch { /* skip malformed line */ }
      }
    }

    onChunk(null);
    return full;
  }
}