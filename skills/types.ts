/**
 * Shared types for OpenRouter API communication.
 * Single source of truth — used by bot.ts, agents.ts, and any module
 * that interacts with the OpenRouter chat completions endpoint.
 */

export interface ORMessage {
  role: string;
  content: string | null;
  tool_calls?: ORToolCall[];
  tool_call_id?: string;
}

export interface ORToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ORResponse {
  choices: Array<{ finish_reason: string; message: ORMessage }>;
}
