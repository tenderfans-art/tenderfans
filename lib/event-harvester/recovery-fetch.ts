import { getTransportRecoveryProxy } from "./transport-recovery-context";
import { signedHarvesterFetch } from "./signed-fetch";

const RECOVERY_STATUSES = new Set([403, 429, 503]);

async function isSiteGroundChallenge(response: Response): Promise<boolean> {
  if (response.status !== 202) return false;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html/i.test(contentType)) return false;

  const body = await response.clone().text();
  return body.includes("/.well-known/sgcaptcha/");
}

export async function recoveryFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = String(input);
  const proxy = getTransportRecoveryProxy();

  // Outside the recovery queue, preserve native fetch exactly.
  if (!proxy) {
    return fetch(url, init);
  }

  // The existing Vultr transport supports GET requests only.
  const method = (init.method ?? "GET").toUpperCase();

  if (method !== "GET") {
    return fetch(url, init);
  }

  try {
    const response = await fetch(url, init);

    const needsRecovery =
      RECOVERY_STATUSES.has(response.status) ||
      await isSiteGroundChallenge(response);

    if (!needsRecovery) {
      return response;
    }

    try {
      const recovered = await signedHarvesterFetch(url, init, proxy);

      if (recovered.ok && !await isSiteGroundChallenge(recovered)) {
        return recovered;
      }

      return response;
    } catch {
      return response;
    }
  } catch {
    return signedHarvesterFetch(url, init, proxy);
  }
}
