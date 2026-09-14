import { ChatGoogle } from '@langchain/google';
import { ChatOpenAICompletions } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { ProviderConfig } from '../shared/contracts';
import { ModelError, type ModelPort, type ModelRequest, stoppedError } from '../core/model-port';
import { withoutTracing } from '../core/privacy';

export type { ModelPort } from '../core/model-port';

/** Whitelist public text; provider reasoning/thought blocks never cross this port. */
export function extractPublicText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== 'object') return [];
    const value = block as Record<string, unknown>;
    if (value.thought === true || value.channel === 'analysis' || (value.type !== 'text' && value.type !== 'output_text')) return [];
    return typeof value.text === 'string' ? [value.text] : [];
  }).join('');
}

/** Some compatible providers put tagged thinking into text instead of content blocks. */
class PublicTextFilter {
  private pending = '';
  private hiddenDepth = 0;
  append(text: string, final = false): string {
    this.pending += text;
    let output = '';
    while (this.pending) {
      const start = this.pending.indexOf('<');
      if (start < 0) {
        if (!this.hiddenDepth) output += this.pending;
        this.pending = '';
        break;
      }
      if (!this.hiddenDepth) output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      const end = this.pending.indexOf('>');
      if (end < 0) {
        if (final) {
          const possiblePrivateTag = /^<\/?(?:t|th|thi|thin|think|thinki|thinkin|thinking|r|re|rea|reas|reaso|reason|reasoni|reasonin|reasoning)$/i.test(this.pending) || /^<\/?(?:think|thinking|reasoning)\s/i.test(this.pending);
          if (!this.hiddenDepth && !possiblePrivateTag) output += this.pending;
          this.pending = '';
        }
        break;
      }
      const tag = this.pending.slice(0, end + 1);
      if (/^<(?:think|thinking|reasoning)(?:\s[^>]*)?>$/i.test(tag)) this.hiddenDepth++;
      else if (/^<\/(?:think|thinking|reasoning)\s*>$/i.test(tag)) this.hiddenDepth = Math.max(0, this.hiddenDepth - 1);
      else if (!this.hiddenDepth) output += tag;
      this.pending = this.pending.slice(end + 1);
    }
    return output;
  }
}

export function sanitizeProviderError(error: unknown): ModelError {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : {};
  const status = value.status ?? response.status;
  if (status === 401 || status === 403) return new ModelError('AUTH', '模型提供方拒绝访问，请检查服务端或本地凭据及模型权限。');
  if (status === 429) return new ModelError('RATE_LIMIT', '模型提供方当前额度或速率受限，本轮未自动重试。');
  return new ModelError('UNAVAILABLE', '模型请求未能完成，请检查模型名称、提供方地址和连接状态。');
}

function endpointUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new ModelError('INVALID_CONFIG', '兼容提供方需要 HTTPS API 基础地址（本机 localhost 可用 HTTP），不能在地址中包含凭据或查询参数。'); }
}

export function createModelPort(config: ProviderConfig, apiKey: string): ModelPort {
  if (!apiKey.trim()) throw new ModelError('INVALID_CONFIG', '尚未配置模型 API Key。');
  if (!config.model.trim()) throw new ModelError('INVALID_CONFIG', '尚未配置模型名称。');
  const baseURL = config.kind === 'openai-compatible' ? endpointUrl(config.baseUrl) : undefined;
  return {
    generate: (request: ModelRequest) => withoutTracing(async () => {
      if (request.signal.aborted) throw stoppedError();
      const modelName = request.member.model?.trim() || config.model.trim();
      try {
        const model = config.kind === 'gemini'
          ? new ChatGoogle({
            apiKey, model: modelName, platformType: 'gai', maxOutputTokens: request.maxOutputTokens,
            thinkingConfig: { includeThoughts: false }, maxRetries: 0, streamUsage: true, callbacks: [], verbose: false,
          })
          : new ChatOpenAICompletions({
            apiKey, model: modelName, configuration: { baseURL }, maxTokens: request.maxOutputTokens,
            maxRetries: 0, streamUsage: false, callbacks: [], verbose: false,
          });
        const system = request.system + (request.json ? '\n本次仅返回合法 JSON 对象，不包含Markdown围栏和JSON以外的文字。' : '');
        const stream = await model.stream([new SystemMessage(system), new HumanMessage(request.prompt)], { signal: request.signal, callbacks: [] });
        const filter = new PublicTextFilter();
        let text = '';
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let lastEmit = 0;
        let truncated = false;
        for await (const chunk of stream) {
          if (request.signal.aborted) throw stoppedError();
          const delta = filter.append(extractPublicText(chunk.content));
          text += delta;
          const usage = chunk.usage_metadata;
          const finish = chunk.response_metadata.finish_reason ?? chunk.additional_kwargs.finishReason;
          if (finish === 'length' || finish === 'MAX_TOKENS') truncated = true;
          // Both adapters normalize streamed usage to additive deltas.
          if (usage && Number.isFinite(usage.input_tokens)) inputTokens = (inputTokens ?? 0) + usage.input_tokens;
          if (usage && Number.isFinite(usage.output_tokens)) outputTokens = (outputTokens ?? 0) + usage.output_tokens;
          if (delta && Date.now() - lastEmit >= 80) { request.onText?.(text); lastEmit = Date.now(); }
        }
        if (request.signal.aborted) throw stoppedError();
        text += filter.append('', true);
        if (truncated) throw new ModelError('TRUNCATED', '模型输出达到本次长度限制，正文不完整；请缩小任务范围或提高输出上限后继续。');
        if (!text.trim()) throw new ModelError('EMPTY_RESPONSE', '提供方没有返回可公开读取的正文。');
        request.onText?.(text);
        return { text, inputTokens, outputTokens };
      } catch (error) {
        if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw stoppedError();
        if (error instanceof ModelError) throw error;
        // SDK errors may contain headers, prompts, URLs with keys or request bodies.
        throw sanitizeProviderError(error);
      }
    }),
  };
}
