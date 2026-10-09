import { getTransportRecoveryProxy } from "./transport-recovery-context";
import { signedHarvesterFetch } from "./signed-fetch";

const RECOVERY_STATUSES = new Set([403, 429, 503]);

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

    if (!RECOVERY_STATUSES.has(response.status)) {
      return response;
    }

    try {
      const recovered = await signedHarvesterFetch(url, init, proxy);
      return recovered.ok ? recovered : response;
    } catch {
      return response;
    }
  } catch {
    return signedHarvesterFetch(url, init, proxy);
  }
}
