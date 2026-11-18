import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getSpotExecutionSignal, getTransportCapacityContext } from "../transport-capacity-context";
import type { CalendarImageAsset } from "./calendar-image-assets";
import type { CalendarImageExtraction } from "./calendar-image-vision";

const RPC_TIMEOUT_MS = 5_000;
const RENEW_INTERVAL_MS = 30_000;
const WAIT_TIMEOUT_MS = 30 * 60_000;

function checkedExtraction(value: unknown): CalendarImageExtraction {
  const result = value as Partial<CalendarImageExtraction> | null;
  if (!result || typeof result !== "object" ||
      typeof result.isEventCalendar !== "boolean" ||
      typeof result.qualificationReason !== "string" ||
      (result.weekStart !== "Monday" && result.weekStart !== "Sunday" && result.weekStart !== null) ||
      !Array.isArray(result.events) || (!result.isEventCalendar && result.events.length > 0)) {
    throw new Error("Calendar image extraction cache returned an invalid payload.");
  }
  return result as CalendarImageExtraction;
}

/** Reuse raw observations only; never reuse a source's attribution or UTC events. */
export async function reuseCalendarImageExtraction(
  asset: CalendarImageAsset,
  contract: string,
  produce: (signal: AbortSignal) => Promise<CalendarImageExtraction>,
): Promise<CalendarImageExtraction> {
  const context = getTransportCapacityContext();
  if (!context) {
    throw new Error("Calendar image extraction requires its source execution context.");
  }
  const key = createHash("sha256").update("calendar-image-extraction-v1\0")
    .update(asset.contentType).update("\0").update(contract).update("\0")
    .update(asset.bytes).digest("hex");
  const token = randomUUID();
  const spotSignal = getSpotExecutionSignal();

  async function rpc(action: "claim" | "renew" | "save" | "release", extraction?: CalendarImageExtraction) {
    const timeout = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const signal = spotSignal && action !== "release"
      ? AbortSignal.any([spotSignal, timeout]) : timeout;
    const { data, error } = await context!.supabase.rpc("calendar_image_extraction_cache", {
      p_cache_key: key, p_claim_token: token, p_action: action,
      p_extraction: extraction ?? null,
    }).abortSignal(signal);
    if (error) {
      throw new Error(`Calendar image extraction cache ${action} failed: ${error.message}`);
    }
    if (!data || typeof data !== "object" || typeof data.state !== "string") {
      throw new Error("Calendar image extraction cache returned an invalid state.");
    }
    return data as { state: string; extraction?: unknown };
  }

  const waitingSince = Date.now();
  for (;;) {
    spotSignal?.throwIfAborted();
    // Cache failures stop before paid parsing; never silently spend again.
    const claim = await rpc("claim");
    spotSignal?.throwIfAborted();
    if (claim.state === "ready") return checkedExtraction(claim.extraction);
    if (claim.state === "claimed") {
      // Renew only this content-cache claim. Original Spot/work deadlines
      // stay authoritative; no per-image parsing budget is shortened or extended.
      const ownership = new AbortController();
      const signal = spotSignal ? AbortSignal.any([spotSignal, ownership.signal]) : ownership.signal;
      let renewal: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (renewal || signal.aborted) return;
        renewal = rpc("renew").then(result => {
          if (result.state !== "renewed") throw new Error("Calendar image extraction cache ownership was lost.");
        }).catch(error => { ownership.abort(error); }).finally(() => { renewal = undefined; });
      }, RENEW_INTERVAL_MS);
      heartbeat.unref();
      try {
        const extraction = checkedExtraction(await produce(signal));
        clearInterval(heartbeat);
        await renewal;
        signal.throwIfAborted();
        const saved = await rpc("save", extraction);
        if (saved.state !== "ready") {
          throw new Error("Calendar image extraction cache ownership was lost before save.");
        }
        return checkedExtraction(saved.extraction);
      } catch (error) {
        clearInterval(heartbeat);
        await renewal;
        // Failed model requests are never cached. A failed cleanup remains
        // bounded by claim expiry and cannot hide the original billing error.
        try { await rpc("release"); } catch { /* Expiring metadata only. */ }
        spotSignal?.throwIfAborted();
        throw error;
      } finally {
        clearInterval(heartbeat);
        await renewal;
      }
    }
    if (!["busy", "missing"].includes(claim.state)) {
      throw new Error(`Calendar image extraction cache claim returned ${claim.state}.`);
    }
    if (Date.now() - waitingSince >= WAIT_TIMEOUT_MS) {
      throw new Error("Calendar image extraction is still being parsed by another worker.");
    }
    await delay(1_000, undefined, { signal: spotSignal });
  }
}
