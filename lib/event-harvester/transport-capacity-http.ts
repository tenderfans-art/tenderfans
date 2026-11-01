import { getTransportCapacityContext } from "./transport-capacity-context";
import { withTransportPermit } from "./transport-capacity-permits";

/*
 * Fetch under a source-scoped HTTP permit.
 *
 * Buffer the body before releasing the permit so the caller can use
 * ordinary Response.text(), Response.json(), and Response.clone().
 *
 * Outside a source capacity context, preserve native fetch behavior.
 */
export async function capacityHttpFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (!getTransportCapacityContext()) {
    return fetch(input, init);
  }

  return withTransportPermit("http", async (permitSignal) => {
    const signal = init.signal
      ? AbortSignal.any([init.signal, permitSignal])
      : permitSignal;

    const response = await fetch(input, {
      ...init,
      signal,
    });

    /*
     * Keep the HTTP permit until the complete response is consumed.
     * Reject oversized responses before allocating an unbounded buffer.
     */
    const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let total = 0;

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const length = Number(declaredLength);
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error("HTTP response exceeds capacity size limit.");
      }
    }

    if (response.body) {
      const reader = response.body.getReader();
      let completed = false;

      try {
        while (true) {
          permitSignal.throwIfAborted();

          const { done, value } = await reader.read();

          if (done) {
            completed = true;
            break;
          }

          total += value.byteLength;

          if (total > MAX_RESPONSE_BYTES) {
            throw new Error(
              "HTTP response exceeds capacity size limit.",
            );
          }

          chunks.push(value);
        }
      } finally {
        if (!completed) {
          await reader.cancel().catch(() => {});
        }
        reader.releaseLock();
      }
    }

    permitSignal.throwIfAborted();

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const nullBodyStatus = [101, 103, 204, 205, 304].includes(
      response.status,
    );

    const buffered = new Response(
      nullBodyStatus ? null : bytes.buffer,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );

    Object.defineProperty(buffered, "url", {
      value: response.url,
      configurable: true,
    });

    return buffered;
  });
}
