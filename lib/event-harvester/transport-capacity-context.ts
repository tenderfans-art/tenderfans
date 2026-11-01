import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

/*
 * Source-scoped transport capacity context.
 *
 * This module does not acquire permits or change network behavior.
 * It only makes the source's existing database client available
 * to transport boundaries through asynchronous call chains.
 *
 * Actual admission must be coordinated by PostgreSQL RPCs.
 */

export type TransportCapacityKind =
  | "http"
  | "browser"
  | "recovery";

type TransportCapacityContext = {
  supabase: SupabaseClient;
  sourceId: string;
};

const storage =
  new AsyncLocalStorage<TransportCapacityContext>();

export function runWithTransportCapacityContext<T>(
  supabase: SupabaseClient,
  sourceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sourceId) {
    throw new Error("Transport capacity source ID is required.");
  }

  return storage.run(
    { supabase, sourceId },
    operation,
  );
}

export function getTransportCapacityContext():
  Readonly<TransportCapacityContext> | undefined {
  return storage.getStore();
}
