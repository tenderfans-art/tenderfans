import { mkdir, rmdir } from "node:fs/promises";

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

/*
 * Reuse one initialization promise within a Node process.
 * A failed initialization must be retryable, not cached forever.
 */
export function singleFlight<T>(
  initialize: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;

  return () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(initialize)
        .catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
    }

    return pending;
  };
}

/*
 * mkdir is atomic on the local filesystem.
 *
 * Unlike a module-level Promise, this also coordinates separate
 * Node processes sharing the Chromium extraction directory.
 *
 * Never remove another process's lock because of age alone.
 * If the owner terminates without cleanup, fail closed rather
 * than execute a potentially incomplete binary.
 */
export async function withFilesystemInitLock<T>(
  initialize: () => Promise<T>,
  lockDirectory: string,
  waitMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      await mkdir(lockDirectory);
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          "Chromium initialization lock remained occupied; " +
          "refusing to launch an unverified executable",
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }

  try {
    return await initialize();
  } finally {
    // Only this invocation successfully created the directory.
    await rmdir(lockDirectory);
  }
}
