/**
 * Anthropic (Claude) LLM Provider.
 *
 * Uses the Messages API via native fetch.
 * Requires ANTHROPIC_API_KEY env var.
 */

import type { LLMProvider, GenerateOptions, StreamHooks } from './provider.js';
import { sseData } from './sse.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private apiKey: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    return this.generateStream(prompt, options);
  }

  async generateStream(prompt: string, options?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    const body: Record<string, unknown> = {
      model: options?.model ?? this.model, // per-call model override (G2)
      max_tokens: options?.maxTokens ?? 8192,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };

    if (options?.system) {
      body.system = options.system;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    let out = '';
    let bytes = 0;
    let firstByteSeen = false;

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') break;
      let ev: {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
      };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const text = ev.delta.text ?? '';
        if (text.length === 0) continue;
        if (!firstByteSeen) {
          firstByteSeen = true;
          hooks?.onFirstByte?.();
        }
        out += text;
        bytes += Buffer.byteLength(text, 'utf8');
        hooks?.onChunk?.(bytes, text);
      }
      // message_delta carries the terminal stop_reason — `max_tokens` means the
      // output was truncated at the budget, recognized as truncation not a stall.
      if (ev.type === 'message_delta' && typeof ev.delta?.stop_reason === 'string') {
        hooks?.onStopReason?.(ev.delta.stop_reason);
      }
    }
    hooks?.onStreamEnd?.();

    if (out.length === 0) {
      throw new Error('Anthropic returned no text content');
    }
    return out;
  }
}
