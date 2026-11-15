import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FacebookEvent } from "./first-party/facebook-events";
import { getSpotExecutionSignal } from "./transport-capacity-context";

type Context = {
  supabase: SupabaseClient;
  workId: string;
  leaseToken: string;
};

const storage = new AsyncLocalStorage<Context>();
const RPC_TIMEOUT_MS = 5_000;

// Source identity, attribution and ingestion stay with each original caller.
// Only successful adapter inventory can be reused within a scheduled cycle.
export function runWithMarketFacebookInventory<T>(
  supabase: SupabaseClient,
  workId: string,
  leaseToken: string,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run({ supabase, workId, leaseToken }, operation);
}

function pageKey(sourceUrl: string): string | null {
  if (sourceUrl.length > 1024) return null;
  try {
    const url = new URL(sourceUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com"]
        .includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port
    ) return null;

    // The existing Facebook adapter uses HTTPS and the www host. Keep
    // pathname case and every query parameter, including profile.php?id.
    url.protocol = "https:";
    url.hostname = "www.facebook.com";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (url.pathname === "/") return null;
    const key = url.toString();
    return key.length <= 1024 ? key : null;
  } catch {
    return null;
  }
}

function isInventory(value: unknown): value is FacebookEvent[] {
  const nullable = (field: unknown) => field === null || typeof field === "string";
  return Array.isArray(value) && value.every((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const event = item as Record<string, unknown>;
    return typeof event.externalEventId === "string" &&
      typeof event.sourceUrl === "string" && typeof event.title === "string" &&
      typeof event.startsAt === "string" && typeof event.allDay === "boolean" &&
      typeof event.allowSourceDefaultAttribution === "boolean" &&
      ["description", "endsAt", "flyerUrl", "location", "venueName", "venueAddress"]
        .every(key => nullable(event[key])) &&
      event.rawPayload !== null && typeof event.rawPayload === "object" &&
      !Array.isArray(event.rawPayload);
  });
}

function log(context: Context, event: string, validate: boolean, extra = {}) {
  try {
    console.info("[market-facebook-inventory]", JSON.stringify({
      event, workId: context.workId, validatePageIdentity: validate, ...extra,
    }));
  } catch {
    // Optional reuse diagnostics never affect the original pipeline.
  }
}

async function inventoryRpc(
  context: Context,
  pageUrl: string,
  validate: boolean,
  events: FacebookEvent[] | null,
): Promise<unknown> {
  const parent = getSpotExecutionSignal();
  parent?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  timer.unref();
  let rejectAborted: (() => void) | undefined;
  try {
    const request = context.supabase.rpc("market_facebook_inventory", {
      p_work_id: context.workId,
      p_lease_token: context.leaseToken,
      p_page_url: pageUrl,
      p_validate_page_identity: validate,
      p_events: events,
    }).abortSignal(controller.signal);
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(controller.signal.reason);
      if (controller.signal.aborted) rejectAborted();
      else controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    // Bound the optional cache even if an RPC implementation ignores abort.
    const response = await Promise.race([Promise.resolve(request), aborted]);
    parent?.throwIfAborted();
    if (response.error) throw new Error("Facebook inventory cache RPC failed");
    return response.data;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
  }
}

export async function reuseMarketFacebookInventory(
  sourceUrl: string,
  validatePageIdentity: boolean,
  fetch: () => Promise<FacebookEvent[]>,
): Promise<FacebookEvent[]> {
  const context = storage.getStore();
  if (!context) return fetch();
  getSpotExecutionSignal()?.throwIfAborted();
  const pageUrl = pageKey(sourceUrl);
  if (!pageUrl) {
    log(context, "bypass", validatePageIdentity, { reason: "page-key-unavailable" });
    return fetch();
  }

  try {
    const cached = await inventoryRpc(context, pageUrl, validatePageIdentity, null);
    getSpotExecutionSignal()?.throwIfAborted();
    if (isInventory(cached)) {
      const result = structuredClone(cached);
      log(context, "hit", validatePageIdentity, { count: result.length });
      return result;
    }
    log(context, cached === null ? "miss" : "error", validatePageIdentity,
      cached === null ? {} : { phase: "read", reason: "invalid-inventory" });
  } catch {
    getSpotExecutionSignal()?.throwIfAborted();
    log(context, "error", validatePageIdentity, { phase: "read" });
  }

  const fresh = await fetch();
  getSpotExecutionSignal()?.throwIfAborted();
  if (!isInventory(fresh)) {
    log(context, "bypass", validatePageIdentity, { reason: "invalid-inventory" });
    return fresh;
  }

  try {
    // Publish a private copy. Another concurrent success may win the DB
    // insertion; this caller must still receive its own original result.
    const saved = await inventoryRpc(
      context, pageUrl, validatePageIdentity, structuredClone(fresh),
    );
    getSpotExecutionSignal()?.throwIfAborted();
    log(context, isInventory(saved) ? "stored" : "bypass", validatePageIdentity,
      isInventory(saved) ? { count: saved.length } : { reason: "not-stored" });
  } catch {
    getSpotExecutionSignal()?.throwIfAborted();
    log(context, "error", validatePageIdentity, { phase: "publish" });
  }
  return fresh;
}
