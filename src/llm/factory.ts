/**
 * LLM adapter factory: maps a provider id to its adapter implementation.
 */

import type { LLMAdapter, LLMProviderConfig, LLMProviderId } from '../core/types.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

export function createLLMAdapter(cfg: LLMProviderConfig): LLMAdapter {
  switch (cfg.id) {
    case 'openai':
    case 'openrouter':
    case 'ollama':
      return new OpenAICompatibleAdapter(cfg);
    case 'anthropic':
      return new AnthropicAdapter(cfg);
    case 'gemini':
      return new GeminiAdapter(cfg);
    default: {
      const exhaustive: never = cfg.id satisfies never;
      throw new Error(`No LLM adapter for provider "${String(exhaustive)}"`);
    }
  }
}

export function assertApiKeyPresent(cfg: LLMProviderConfig): void {
  if (cfg.id === 'ollama') return; // local server needs no key
  if (!cfg.apiKey) {
    const envVar =
      cfg.id === 'openai'
        ? 'OPENAI_API_KEY'
        : cfg.id === 'openrouter'
          ? 'OPENROUTER_API_KEY'
          : cfg.id === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'GEMINI_API_KEY';
    throw new Error(
      `Provider "${cfg.id}" needs an API key. Set ${envVar} in .env or the environment (see .env.example).`,
    );
  }
}

export type { LLMProviderId };
