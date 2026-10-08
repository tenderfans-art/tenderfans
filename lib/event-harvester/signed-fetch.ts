import { ProxyAgent, fetch as undiciFetch } from "undici";

import {
  appendSignature,
  createSignature,
  webcrypto,
} from "http-message-sig";

const KEY_ID =
  "DMxaKvsNLa--peOwitbvLDIkMQce0XbBRWj7mIiwymQ";

const SIGNATURE_AGENT = '"https://tenderfans.com"';
const MAX_REDIRECTS = 5;

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

  try {
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const parsed = new URL(currentUrl);

    if (parsed.protocol !== "https:") {
      throw new Error("Signed harvester fetch requires HTTPS.");
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
            signal: init.signal ?? undefined,
          });

          const body = await proxied.arrayBuffer();

          return new Response(body, {
            status: proxied.status,
            statusText: proxied.statusText,
            headers: Array.from(
              proxied.headers.entries(),
              ([name, value]): [string, string] => [name, value],
            ),
          });
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
