import { ProxyAgent, fetch as undiciFetch } from "undici";
import { isIP } from "node:net";

import {
  appendSignature,
  createSignature,
  webcrypto,
} from "http-message-sig";

const KEY_ID =
  "DMxaKvsNLa--peOwitbvLDIkMQce0XbBRWj7mIiwymQ";

const SIGNATURE_AGENT = '"https://tenderfans.com"';
const MAX_REDIRECTS = 5;
const PROXY_TIMEOUT_MS = 15_000;
const MAX_PROXY_RESPONSE_BYTES = 2 * 1024 * 1024;

function validateProxyDestination(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error("Proxy recovery requires HTTPS.");
  }

  if (url.port && url.port !== "443") {
    throw new Error("Proxy recovery requires destination port 443.");
  }

  if (url.username || url.password) {
    throw new Error("Proxy recovery rejects URL credentials.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    isIP(host.replace(/^\[|\]$/g, "")) !== 0
  ) {
    throw new Error("Proxy recovery requires a public DNS hostname.");
  }
}

async function readLimitedBody(
  response: Awaited<ReturnType<typeof undiciFetch>>,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));

  if (Number.isFinite(length) && length > MAX_PROXY_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Proxy response exceeds size limit.");
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        completed = true;
        break;
      }

      total += value.byteLength;

      if (total > MAX_PROXY_RESPONSE_BYTES) {
        throw new Error("Proxy response exceeds size limit.");
      }

      chunks.push(value);
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

async function getSigner() {
  const pem = process.env.TENDERFANS_WBA_PRIVATE_KEY;

  if (!pem) {
    throw new Error("Harvester WBA private key is missing.");
  }

  const base64 = pem
    .replace(/\\n/g, "\\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\s+/g, "");

  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(
      Buffer.from(base64, "base64"),
    ).buffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  return webcrypto.signer(key);
}

export async function signedHarvesterFetch(
  url: string,
  init: RequestInit = {},
  proxyUrl?: string,
): Promise<Response> {
  if (init.method && init.method.toUpperCase() !== "GET") {
    throw new Error("Signed harvester fetch supports GET only.");
  }

  const configuredKeyId =
    process.env.TENDERFANS_WBA_KEY_ID ?? KEY_ID;

  if (configuredKeyId !== KEY_ID) {
    throw new Error("Harvester WBA key ID mismatch.");
  }

  const signer = await getSigner();
  let currentUrl = url;
  const proxy = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  const timeoutSignal = proxy
    ? AbortSignal.timeout(PROXY_TIMEOUT_MS)
    : undefined;

  const signal = proxy
    ? init.signal
      ? AbortSignal.any([init.signal, timeoutSignal!])
      : timeoutSignal
    : init.signal;

  try {
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const parsed = new URL(currentUrl);

    if (parsed.protocol !== "https:") {
      throw new Error("Signed harvester fetch requires HTTPS.");
    }

    if (proxy) {
      validateProxyDestination(parsed);
    }

    const headers = new Headers(init.headers);

    headers.set("Signature-Agent", SIGNATURE_AGENT);

    const request = new Request(parsed.toString(), {
      ...init,
      method: "GET",
      headers,
      redirect: "manual",
    });

    const now = Math.floor(Date.now() / 1000);

    const signature = await createSignature(request, {
      label: "sig1",
      components: [
        "@authority",
        "signature-agent",
      ],
      parameters: {
        created: now,
        expires: now + 60,
        keyid: KEY_ID,
        alg: "ed25519",
        tag: "web-bot-auth",
      },
      signer,
    });

    const signedHeaders = appendSignature(
      request.headers,
      signature,
    );

    const response: Response = proxy
      ? await (async () => {
          const proxied = await undiciFetch(request.url, {
            method: "GET",
            headers: signedHeaders,
            redirect: "manual",
            dispatcher: proxy,
            signal,
          });

          const body = await readLimitedBody(proxied);

          return new Response(
            Uint8Array.from(body).buffer,
            {
              status: proxied.status,
              statusText: proxied.statusText,
              headers: Array.from(
                proxied.headers.entries(),
                ([name, value]): [string, string] => [name, value],
              ),
            },
          );
        })()
      : await fetch(request.url, {
          ...init,
          method: "GET",
          headers: signedHeaders,
          redirect: "manual",
        });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (proxy) {
        Object.defineProperty(response, "url", {
          value: request.url,
          configurable: true,
        });
      }
      return response;
    }

    if (redirects === MAX_REDIRECTS) {
      throw new Error("Harvester redirect limit exceeded.");
    }

    const location = response.headers.get("location");

    if (!location) {
      if (proxy) {
        Object.defineProperty(response, "url", {
          value: request.url,
          configurable: true,
        });
      }
      return response;
    }

    const nextUrl = new URL(location, request.url);

    // Legacy websites sometimes issue HTTP redirects even though
    // their destinations support HTTPS. Upgrade before requesting:
    // the harvester must never transmit a request over HTTP.
    if (nextUrl.protocol === "http:") {
      nextUrl.protocol = "https:";
    }

    if (nextUrl.protocol !== "https:") {
      throw new Error(
        "Harvester refused redirect to non-HTTPS destination.",
      );
    }

    if (proxy) {
      await response.body?.cancel();
    }

    currentUrl = nextUrl.toString();
  }

  throw new Error("Harvester redirect limit exceeded.");
  } finally {
    if (proxy) {
      await proxy.close();
    }
  }
}
