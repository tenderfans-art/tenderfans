import { isVerificationInterstitial } from "./access-challenge";

const COMPATIBLE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

async function challenged(response: Response): Promise<boolean> {
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
  if (!/text\/html/i.test(response.headers.get("content-type") ?? "")) return false;
  const html = await response.clone().text();
  return isVerificationInterstitial(html) || /\/cdn-cgi\/challenge-platform\/|\/\.well-known\/sgcaptcha\//i.test(html);
}

/** Apply the detector's existing request-header compatibility to resource fetches. */
export async function withCompatibleHttpHeaders(
  request: (headers: Headers) => Promise<Response>,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const original = await request(headers);
  if ((init.method ?? "GET").toUpperCase() !== "GET" || original.status !== 403 ||
      headers.get("user-agent") === COMPATIBLE_USER_AGENT || await challenged(original)) {
    return original;
  }

  const compatible = new Headers(headers);
  compatible.set("User-Agent", COMPATIBLE_USER_AGENT);
  compatible.set("Accept-Language", "en-US,en;q=0.9");
  // The original transport still owns signing, limits, signals and permits.
  const response = await request(compatible);
  return response.ok && !await challenged(response) ? response : original;
}
