/**
 * Minimal Server-Sent-Events line reader for streaming API responses.
 *
 * Yields the payload after each `data:` field from a fetch Response body.
 * Used by the Anthropic and OpenAI providers to surface time-to-first-byte
 * and incremental progress (PRD O1/O2).
 */

export async function* sseData(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        yield line.slice(5).trim();
      }
    }
  }
}
