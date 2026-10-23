import { isVerificationInterstitial } from "./access-challenge";
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

async function isVerificationChallenge(response: Response): Promise<boolean> {
  if (!response.ok) return false;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html/i.test(contentType)) return false;

  return isVerificationInterstitial(await response.clone().text());
}

export async function recoveryFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = String(input);
  const proxy = getTransportRecoveryProxy();

  // Outside the recovery queue, preserve native transport while
  // rejecting recognized verification HTML as adapter content.
  if (!proxy) {
    const response = await fetch(url, init);

    if (await isVerificationChallenge(response)) {
      throw new Error(
        "Access challenge encountered: verification interstitial"
      );
    }

    return response;
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
      await isSiteGroundChallenge(response) ||
      await isVerificationChallenge(response);

    if (!needsRecovery) {
      return response;
    }

    try {
      const recovered = await signedHarvesterFetch(url, init, proxy);

      if (
        recovered.ok &&
        !await isSiteGroundChallenge(recovered) &&
        !await isVerificationChallenge(recovered)
      ) {
        return recovered;
      }

      if (await isVerificationChallenge(response)) {
        throw new Error(
          "Access challenge encountered: verification interstitial"
        );
      }

      return response;
    } catch (error) {
      if (await isVerificationChallenge(response)) {
        throw new Error(
          "Access challenge encountered: verification interstitial",
          { cause: error }
        );
      }

      return response;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "Access challenge encountered: verification interstitial"
    ) {
      throw error;
    }

    const recovered = await signedHarvesterFetch(url, init, proxy);

    if (await isVerificationChallenge(recovered)) {
      throw new Error(
        "Access challenge encountered: verification interstitial"
      );
    }

    return recovered;
  }
}
