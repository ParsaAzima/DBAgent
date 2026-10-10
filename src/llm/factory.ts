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
    case 'custom':
      return new OpenAICompatibleAdapter(cfg);
    case 'anthropic':
      return new AnthropicAdapter(cfg);
    case 'gemini':
      return new GeminiAdapter(cfg);
  }
}

export function assertApiKeyPresent(cfg: LLMProviderConfig): void {
  if (cfg.id === 'ollama' || (cfg.id === 'custom' && !cfg.apiKeyRequired)) return;
  if (!cfg.apiKey) {
    const envVar =
      cfg.id === 'openai'
        ? 'OPENAI_API_KEY'
        : cfg.id === 'openrouter'
          ? 'OPENROUTER_API_KEY'
          : cfg.id === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : cfg.id === 'custom'
              ? (cfg.apiKeyEnv ?? 'the configured API key environment variable')
              : 'GEMINI_API_KEY';
    throw new Error(
      `Provider "${cfg.providerName ?? cfg.id}" needs an API key. Set [llm] api_key in dbagent.toml, or ${envVar} in .env/the environment (see dbagent.example.toml).`,
    );
  }
}

export type { LLMProviderId };
