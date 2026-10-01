/**
 * Shared message translation: normalized AgentMessage → OpenAI wire format.
 * Used by both the non-streaming and streaming OpenAI-compatible paths.
 */

import type { AgentMessage } from '../core/types.js';

export function toOpenAIMessage(m: AgentMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId,
      content: JSON.stringify(m.toolResult ?? null),
    };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}
