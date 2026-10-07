import { describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_INTERVAL_MS, withKeepAlive } from './stream-keepalive';

/**
 * Read a stream to completion, returning the decoded chunks in order.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const out: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    out.push(decoder.decode(value));
  }

  return out;
}

/** A stream that emits nothing for `silenceMs`, then one chunk, then closes. */
function slowStream(silenceMs: number, payload = '0:"hello"\n'): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, silenceMs));
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

describe('withKeepAlive', () => {
  it('emits a first byte immediately, before the model has produced anything', async () => {
    // CloudFront's OriginReadTimeout on the API Gateway origin is 30s. A model
    // that thinks before emitting its first text token sends nothing in that
    // window, so CloudFront returns 504 and the client sees the chat fail — which
    // is exactly what Sonnet 5 did in prod while Sonnet 4.6 (first token well
    // inside 30s) worked. Something has to go down the wire straight away.
    const stream = withKeepAlive(slowStream(50));
    const reader = stream.getReader();

    const first = await reader.read();
    await reader.cancel();

    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe('0:""\n');
  });

  it('keeps emitting while the model stays silent', async () => {
    vi.useFakeTimers();

    try {
      const stream = withKeepAlive(
        new ReadableStream({
          start() {
            // never emits, never closes
          },
        }),
      );
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      // the immediate one
      expect(decoder.decode((await reader.read()).value)).toBe('0:""\n');

      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
      expect(decoder.decode((await reader.read()).value)).toBe('0:""\n');

      await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS + 10);
      expect(decoder.decode((await reader.read()).value)).toBe('0:""\n');

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the interval comfortably under the CloudFront origin read timeout', () => {
    // 30s is the configured OriginReadTimeout. Leave room for jitter and for a
    // slow hop rather than sitting right on the limit.
    expect(KEEPALIVE_INTERVAL_MS).toBeLessThan(15_000);
  });

  it('passes the model output through unchanged', async () => {
    const chunks = await drain(withKeepAlive(slowStream(0, '0:"real token"\n')));

    expect(chunks).toContain('0:"real token"\n');
  });

  it('does not corrupt the stream when output arrives in several chunks', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('0:"one"\n'));
        controller.enqueue(encoder.encode('0:"two"\n'));
        controller.close();
      },
    });

    const chunks = await drain(withKeepAlive(source));
    const real = chunks.filter((c) => c !== '0:""\n');

    expect(real).toEqual(['0:"one"\n', '0:"two"\n']);
  });

  it('closes when the model stream closes, and stops the heartbeat', async () => {
    const chunks = await drain(withKeepAlive(slowStream(10)));

    // Terminates at all — an un-cleared interval would hold the stream open.
    expect(chunks.at(-1)).toBe('0:"hello"\n');
  });

  it('propagates a source error rather than hiding it behind heartbeats', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('bedrock exploded'));
      },
    });

    await expect(drain(withKeepAlive(source))).rejects.toThrow('bedrock exploded');
  });
});
