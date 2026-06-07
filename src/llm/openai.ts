/**
 * OpenAI (GPT) LLM Provider.
 *
 * Uses the Chat Completions API via native fetch.
 * Requires OPENAI_API_KEY env var.
 */

import type { LLMProvider, GenerateOptions, StreamHooks } from './provider.js';
import { sseData } from './sse.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
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
    const messages: Array<{ role: string; content: string }> = [];

    if (options?.system) {
      messages.push({ role: 'system', content: options.system });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: options?.maxTokens ?? 8192,
      stream: true,
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    let out = '';
    let bytes = 0;
    let firstByteSeen = false;

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') break;
      let ev: { choices?: Array<{ delta?: { content?: string } }> };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const text = ev.choices?.[0]?.delta?.content ?? '';
      if (text.length === 0) continue;
      if (!firstByteSeen) {
        firstByteSeen = true;
        hooks?.onFirstByte?.();
      }
      out += text;
      bytes += Buffer.byteLength(text, 'utf8');
      hooks?.onChunk?.(bytes, text);
    }
    hooks?.onStreamEnd?.();

    if (out.length === 0) {
      throw new Error('OpenAI returned no text content');
    }
    return out;
  }
}
