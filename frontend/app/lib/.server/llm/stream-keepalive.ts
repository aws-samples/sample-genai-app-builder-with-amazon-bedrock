/**
 * Keeping a chat response alive while the model is still thinking.
 *
 * `/stream` reaches the browser through CloudFront, whose `OriginReadTimeout` on
 * the API Gateway origin is 30 seconds. That timeout measures the gap between
 * bytes, not the total response length — so a long answer is fine as long as it
 * keeps trickling, but a long *silence before the first token* is fatal.
 *
 * That is exactly what happened in prod: Claude Sonnet 4.6 emitted its first
 * text token well inside 30s and streamed for 64 seconds quite happily, while
 * Sonnet 5 spent longer before its first text token and CloudFront returned a
 * 504 before anything arrived. The Lambda was left mid-invocation with no END
 * record, because the client had already gone.
 *
 * Emitting an empty text delta immediately, and again during any silence, means
 * CloudFront always sees traffic. `0:""` is a well-formed AI-SDK text delta that
 * appends nothing, so the client renders it as no content at all.
 */

/**
 * How often to emit a heartbeat while the model is silent.
 *
 * Well under the 30s `OriginReadTimeout` so a slow hop or a little jitter cannot
 * push a gap over the limit.
 */
export const KEEPALIVE_INTERVAL_MS = 10_000;

/** An AI-SDK text delta carrying no text. */
const HEARTBEAT = '0:""\n';

/**
 * Wrap a chat stream so it always has bytes in flight.
 *
 * The heartbeat starts before the first read of `source`, stops as soon as the
 * source closes or errors, and never interleaves inside a source chunk — each
 * enqueue is a whole protocol line either way, so the client's parser cannot see
 * a partial frame.
 */
export function withKeepAlive(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  /**
   * The reader holds a lock on `source`, so cancelling must go through it —
   * calling `source.cancel()` while it is locked throws "ReadableStream is
   * locked" and turns a clean client disconnect into an error.
   */
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const stopHeartbeat = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Straight away, so CloudFront's clock never starts from zero.
      controller.enqueue(encoder.encode(HEARTBEAT));

      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(HEARTBEAT));
        } catch {
          // The stream is already closed or cancelled; nothing left to keep alive.
          stopHeartbeat();
        }
      }, KEEPALIVE_INTERVAL_MS);

      reader = source.getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          controller.enqueue(value);
        }

        stopHeartbeat();
        controller.close();
      } catch (error) {
        // Surface the failure rather than letting the heartbeat make a dead
        // stream look healthy forever.
        stopHeartbeat();
        controller.error(error);
      }
    },
    async cancel(reason) {
      stopHeartbeat();

      // `reader.cancel()` cancels the underlying source too, and is safe while
      // the lock is held. Before the first read there is no reader yet.
      await (reader ? reader.cancel(reason) : source.cancel(reason));
    },
  });
}
