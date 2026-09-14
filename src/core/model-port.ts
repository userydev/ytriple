import type { Member } from '../shared/contracts';

/** A model invocation is an independent, scoped member contribution. */
export interface ModelRequest {
  system: string;
  prompt: string;
  member: Member;
  json: boolean;
  signal: AbortSignal;
  maxOutputTokens: number;
  onText?: (text: string) => void;
}

export interface ModelResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelPort {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(public readonly code: 'AUTH' | 'RATE_LIMIT' | 'UNAVAILABLE' | 'INVALID_CONFIG' | 'EMPTY_RESPONSE' | 'TRUNCATED', message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export function stoppedError(): Error {
  const error = new Error('本次调用已停止；提供方是否停止生成和计费未获确认。');
  error.name = 'AbortError';
  return error;
}
