import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getTransportCapacityContext,
  type TransportCapacityKind,
} from "./transport-capacity-context";

const LEASE_SECONDS = 120;
const RENEW_INTERVAL_MS = 30_000;
const ACQUIRE_WAIT_MS = 60_000;
const ACQUIRE_RETRY_MS = 500;
const RPC_TIMEOUT_MS = 15_000;

type Permit = {
  id: string;
  token: string;
  expiresAt: number;
};

type PermitRow = {
  permit_id: string;
  permit_token: string;
  permit_expires_at: string;
};

export class TransportCapacityUnavailableError extends Error {
  constructor(kind: TransportCapacityKind) {
    super(`Transport capacity unavailable: ${kind}`);
    this.name = "TransportCapacityUnavailableError";
  }
}

export class TransportPermitOwnershipLostError extends Error {
  constructor(kind: TransportCapacityKind) {
    super(`Transport permit ownership lost: ${kind}`);
    this.name = "TransportPermitOwnershipLostError";
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  return new DOMException("Transport operation aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(error);
      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal!));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}


async function releaseAcquisition(
  supabase: SupabaseClient,
  acquisitionKey: string,
  kind: TransportCapacityKind,
  sourceId: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    RPC_TIMEOUT_MS,
  );

  try {
    const { error } = await supabase.rpc(
      "release_event_processing_transport_acquisition",
      {
        p_acquisition_key: acquisitionKey,
        p_transport_kind: kind,
        p_source_id: sourceId,
      },
    ).abortSignal(controller.signal);

    if (error) {
      throw new Error(
        `Transport acquisition cleanup failed: ${error.message}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function acquirePermit(
  supabase: SupabaseClient,
  kind: TransportCapacityKind,
  sourceId: string,
  signal?: AbortSignal,
): Promise<Permit> {
  const deadline = Date.now() + ACQUIRE_WAIT_MS;
  const acquisitionKey = crypto.randomUUID();
  let acquired = false;
  let acquisitionDispatched = false;
  let acquisitionFailure: unknown = null;

  try {
    while (true) {
    throwIfAborted(signal);

    /*
     * The RPC itself may already be in flight when cancellation
     * arrives. Never abandon an acquisition RPC: it could grant
     * a permit that would otherwise be orphaned.
     */
    const rpcController = new AbortController();
    const rpcTimer = setTimeout(
      () => rpcController.abort(),
      RPC_TIMEOUT_MS,
    );

    let data: unknown;
    let error: { message: string } | null;

    try {
      acquisitionDispatched = true;

      const response = await supabase.rpc(
      "acquire_event_processing_transport_permit",
      {
        p_transport_kind: kind,
        p_source_id: sourceId,
        p_lease_seconds: LEASE_SECONDS,
        p_acquisition_key: acquisitionKey,
      },
    ).abortSignal(rpcController.signal);
      data = response.data;
      error = response.error;
    } finally {
      clearTimeout(rpcTimer);
    }

    const rows = data as PermitRow[] | null;
    const row = rows?.[0];

    if (row && signal?.aborted) {
      throw abortReason(signal);
    }

    throwIfAborted(signal);

    if (error) {
      /*
       * The database outcome may be unknown after an HTTP
       * failure. Retry with the SAME acquisition key.
       *
       * Explicit PostgreSQL errors must not be retried
       * indefinitely; they indicate a rejected request.
       */
      const retryable =
        rpcController.signal.aborted ||
        error.message === "TypeError: Failed to fetch" ||
        error.message === "Failed to fetch";

      if (!retryable) {
        throw new Error(
          `Transport permit acquisition failed: ${error.message}`,
        );
      }

      if (Date.now() >= deadline) {
        throw new TransportCapacityUnavailableError(kind);
      }

      await sleep(
        Math.min(
          ACQUIRE_RETRY_MS,
          Math.max(1, deadline - Date.now()),
        ),
        signal,
      );
      continue;
    }

    if (row) {
      // Reject late grants; cleanup cancels the acquisition.
      if (Date.now() >= deadline) {
        throw new TransportCapacityUnavailableError(kind);
      }

      const permit: Permit = {
        id: row.permit_id,
        token: row.permit_token,
        expiresAt: Date.parse(row.permit_expires_at),
      };

      if (
        !permit.id ||
        !permit.token ||
        !Number.isFinite(permit.expiresAt) ||
        permit.expiresAt <= Date.now()
      ) {
        throw new TransportPermitOwnershipLostError(kind);
      }

      acquired = true;
      return permit;
    }

    if (Date.now() >= deadline) {
      throw new TransportCapacityUnavailableError(kind);
    }

    await sleep(
      Math.min(ACQUIRE_RETRY_MS, Math.max(1, deadline - Date.now())),
      signal,
    );
    }
  } catch (error) {
    acquisitionFailure = error;
    throw error;
  } finally {
    if (!acquired && acquisitionDispatched) {
      try {
        let cleanupFailure: unknown = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await releaseAcquisition(
              supabase,
              acquisitionKey,
              kind,
              sourceId,
            );
            cleanupFailure = null;
            break;
          } catch (error) {
            cleanupFailure = error;

            if (attempt < 3) {
              await sleep(250 * attempt);
            }
          }
        }

        if (cleanupFailure) {
          throw cleanupFailure;
        }
      } catch (cleanupError) {
        if (acquisitionFailure instanceof Error) {
          Object.defineProperty(
            acquisitionFailure,
            "cleanupError",
            {
              value: cleanupError,
              enumerable: true,
              configurable: true,
            },
          );
        } else {
          throw cleanupError;
        }
      }
    }
  }
}

async function renewPermit(
  supabase: SupabaseClient,
  permit: Permit,
): Promise<boolean> {
  const rpcController = new AbortController();
  const rpcTimer = setTimeout(
    () => rpcController.abort(),
    RPC_TIMEOUT_MS,
  );

  let data: unknown;
  let error: { message: string } | null;

  try {
    const response = await supabase.rpc(
    "renew_event_processing_transport_permit",
    {
      p_permit_id: permit.id,
      p_permit_token: permit.token,
      p_lease_seconds: LEASE_SECONDS,
    },
  ).abortSignal(rpcController.signal);
    data = response.data;
    error = response.error;
  } finally {
    clearTimeout(rpcTimer);
  }

  if (error) {
    throw new Error(
      `Transport permit renewal failed: ${error.message}`,
    );
  }

  return data === true;
}

async function releasePermit(
  supabase: SupabaseClient,
  permit: Permit,
): Promise<boolean> {
  const rpcController = new AbortController();
  const rpcTimer = setTimeout(
    () => rpcController.abort(),
    RPC_TIMEOUT_MS,
  );

  let data: unknown;
  let error: { message: string } | null;

  try {
    const response = await supabase.rpc(
    "release_event_processing_transport_permit",
    {
      p_permit_id: permit.id,
      p_permit_token: permit.token,
    },
  ).abortSignal(rpcController.signal);
    data = response.data;
    error = response.error;
  } finally {
    clearTimeout(rpcTimer);
  }

  if (error) {
    throw new Error(
      `Transport permit release failed: ${error.message}`,
    );
  }

  return data === true;
}

/*
 * Executes one bounded transport operation under a database permit.
 *
 * A parent signal allows nested admission to be cancelled while
 * waiting. This is required for recovery -> browser coordination.
 *
 * The caller must honor the signal and finish network/browser
 * cleanup before returning.
 */
export async function withTransportPermit<T>(
  kind: TransportCapacityKind,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfAborted(parentSignal);

  const context = getTransportCapacityContext();

  if (!context) {
    return operation(parentSignal ?? new AbortController().signal);
  }

  const permit = await acquirePermit(
    context.supabase,
    kind,
    context.sourceId,
    parentSignal,
  );

  const controller = new AbortController();

  const onParentAbort = () => {
    controller.abort(abortReason(parentSignal!));
  };

  parentSignal?.addEventListener("abort", onParentAbort, {
    once: true,
  });

  if (parentSignal?.aborted) {
    onParentAbort();
  }

  let stopped = false;
  let renewalFailure: unknown = null;
  // Database expiry is authoritative for the initial lease.
  // Never infer it from when the HTTP response arrives.
  let leaseExpiresAt = permit.expiresAt;

  const renewalWait = {
    cancel: null as (() => void) | null,
  };

  const waitForRenewal = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        renewalWait.cancel = null;
        resolve();
      }, RENEW_INTERVAL_MS);

      renewalWait.cancel = () => {
        clearTimeout(timer);
        renewalWait.cancel = null;
        resolve();
      };
    });

  /*
   * Local expiry is a backstop for a stalled renewal RPC.
   * We do not allow an operation to continue indefinitely
   * merely because the database request has not returned.
   */
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const armExpiry = () => {
    if (expiryTimer) clearTimeout(expiryTimer);

    const remaining = Math.max(0, leaseExpiresAt - Date.now());

    expiryTimer = setTimeout(() => {
      if (!stopped) {
        renewalFailure =
          new TransportPermitOwnershipLostError(kind);
        controller.abort(renewalFailure);
      }
    }, remaining);
  };

  armExpiry();

  const renewalLoop = async (): Promise<void> => {
    while (!stopped && !controller.signal.aborted) {
      await waitForRenewal();

      if (stopped || controller.signal.aborted) return;

      try {
        const renewalStartedAt = Date.now();

        const renewed = await renewPermit(
          context.supabase,
          permit,
        );

        if (stopped || controller.signal.aborted) return;

        if (!renewed) {
          renewalFailure =
            new TransportPermitOwnershipLostError(kind);
          controller.abort(renewalFailure);
          return;
        }

        leaseExpiresAt =
          renewalStartedAt + LEASE_SECONDS * 1000;
        armExpiry();
      } catch (error) {
        renewalFailure = error;
        controller.abort(error);
        return;
      }
    }
  };

  const renewalTask = renewalLoop();

  let operationFailure: unknown = null;
  let result!: T;

  try {
    controller.signal.throwIfAborted();
    result = await operation(controller.signal);
    controller.signal.throwIfAborted();
  } catch (error) {
    operationFailure = error;
  } finally {
    stopped = true;

    renewalWait.cancel?.();

    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }

    parentSignal?.removeEventListener("abort", onParentAbort);

    /*
     * Wait for an in-flight renewal before releasing.
     * A renewal must never finish after permit release.
     */
    try {
      await renewalTask;
    } catch (error) {
      renewalFailure ??= error;
    }

    try {
      const released = await releasePermit(
        context.supabase,
        permit,
      );

      if (!released && !renewalFailure) {
        renewalFailure =
          new TransportPermitOwnershipLostError(kind);
      }
    } catch (error) {
      renewalFailure ??= error;
    }
  }

  if (renewalFailure) throw renewalFailure;
  if (operationFailure) throw operationFailure;

  return result;
}
