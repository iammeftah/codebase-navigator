/**
 * Registry of supported AI providers.
 * Each provider defines how to call its API so the chat handler
 * can send requests without knowing which provider is active.
 */

export type ApiFormat = 'openai' | 'anthropic' | 'ollama';

export interface ProviderDef {
  id: string;
  name: string;
  format: ApiFormat;
  baseUrl: string;
  docsUrl: string;
  keyPlaceholder: string;
  keyRequired: boolean;
  defaultModel: string;
  popularModels: string[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    docsUrl: 'https://console.anthropic.com/keys',
    keyPlaceholder: 'sk-ant-…',
    keyRequired: true,
    defaultModel: 'claude-sonnet-4-20250514',
    popularModels: [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com',
    docsUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    keyRequired: true,
    defaultModel: 'gpt-4o',
    popularModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini'],
  },
  {
    id: 'groq',
    name: 'Groq',
    format: 'openai',
    baseUrl: 'https://api.groq.com/openai',
    docsUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…',
    keyRequired: true,
    defaultModel: 'llama-3.3-70b-versatile',
    popularModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api',
    docsUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-…',
    keyRequired: true,
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    popularModels: [
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-flash-1.5',
      'deepseek/deepseek-chat',
      'mistralai/mistral-7b-instruct',
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    format: 'openai',   // Gemini has an OpenAI-compat endpoint
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    keyRequired: true,
    defaultModel: 'gemini-2.0-flash',
    popularModels: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    format: 'ollama',
    baseUrl: 'http://localhost:11434',
    docsUrl: 'https://ollama.com',
    keyPlaceholder: '(no key needed)',
    keyRequired: false,
    defaultModel: 'llama3.2',
    popularModels: ['llama3.2', 'mistral', 'codellama', 'deepseek-coder'],
  },
  {
    id: 'custom',
    name: 'Custom / Self-hosted',
    format: 'openai',
    baseUrl: 'http://localhost:8080',
    docsUrl: '',
    keyPlaceholder: '(optional)',
    keyRequired: false,
    defaultModel: 'default',
    popularModels: [],
  },
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find(p => p.id === id);
}
