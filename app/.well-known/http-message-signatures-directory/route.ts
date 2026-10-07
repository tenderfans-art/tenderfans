import {
  appendSignature,
  component,
  createSignature,
  webcrypto,
} from "http-message-sig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WBA_KEY_ID =
  "DMxaKvsNLa--peOwitbvLDIkMQce0XbBRWj7mIiwymQ";

const PUBLIC_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "Y99yDsXxllBTSSkxcxpxEmK18WuRxMsgk_7fbzpKeb8",
  kid: WBA_KEY_ID,
} as const;

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n");

  const base64 = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  if (!base64) {
    throw new Error("TENDERFANS_WBA_PRIVATE_KEY is empty or malformed.");
  }

  const bytes = Buffer.from(base64, "base64");

  return Uint8Array.from(bytes).buffer;
}

async function getSigner() {
  const privateKeyPem = process.env.TENDERFANS_WBA_PRIVATE_KEY;

  if (!privateKeyPem) {
    throw new Error("TENDERFANS_WBA_PRIVATE_KEY is not configured.");
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    {
      name: "Ed25519",
    },
    false,
    ["sign"],
  );

  return webcrypto.signer(key);
}

export async function GET(request: Request) {
  const configuredKeyId =
    process.env.TENDERFANS_WBA_KEY_ID ?? WBA_KEY_ID;

  if (configuredKeyId !== WBA_KEY_ID) {
    return new Response("WBA key ID configuration mismatch.", {
      status: 500,
    });
  }

  const body = JSON.stringify({
    keys: [PUBLIC_JWK],
  });

  const headers = new Headers({
    "Content-Type":
      "application/http-message-signatures-directory+json",
    "Cache-Control": "public, max-age=300",
  });

  const responseDescriptor = {
    kind: "response" as const,
    status: 200,
    fields: Array.from(headers.entries()).map(([name, value]) => ({
      name,
      value,
    })),
    request,
  };

  const now = Math.floor(Date.now() / 1000);

  const signature = await createSignature(responseDescriptor, {
    components: [
      component("@authority", {
        req: true,
      }),
    ],
    parameters: {
      created: now,
      expires: now + 300,
      keyid: WBA_KEY_ID,
      tag: "http-message-signatures-directory",
    },
    signer: await getSigner(),
  });

  return new Response(body, {
    status: 200,
    headers: appendSignature(headers, signature),
  });
}
