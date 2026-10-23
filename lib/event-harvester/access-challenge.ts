/**
 * Recognize a verification interstitial by its distinctive page
 * content, not by a generic Cloudflare analytics reference.
 */
export function isVerificationInterstitial(html: string): boolean {
  return (
    /<title[^>]*>\s*one moment, please\.\.\.\s*<\/title>/i.test(html) &&
    /please wait while your request is being verified/i.test(html)
  );
}
