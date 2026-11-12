import Chromium from "@sparticuz/chromium";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  singleFlight,
  withFilesystemInitLock,
} from "./chromium-initialization";

/*
 * These installation markers are scoped to the verified
 * @sparticuz/chromium 153 runtime.
 *
 * They are not source, Spot, adapter, or Market specific.
 */
const TEMP = tmpdir();
const BINARY = join(TEMP, "chromium");

const LOCK = join(
  TEMP,
  ".tenderfans-chromium-153-initialization.lock",
);

const READY = join(
  TEMP,
  ".tenderfans-chromium-153.ready",
);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

const initialize = singleFlight(async (): Promise<string> => {
  return withFilesystemInitLock(async () => {
    const binaryExisted = await exists(BINARY);
    const readyExisted = await exists(READY);

    /*
     * An existing native binary without our completion marker
     * could have been left by a terminated extraction.
     *
     * Do not run it and do not delete an unknown installation.
     */
    if (binaryExisted !== readyExisted) {
      throw new Error(
        "Chromium temporary installation is not verified; " +
        "refusing to use or delete an unknown extraction",
      );
    }

    try {
      const executablePath =
        await Chromium.executablePath();

      const binary = await stat(executablePath);

      /*
       * Version 153's Chromium binary is substantially larger
       * than this minimum. Reject a clearly incomplete output.
       */
      if (
        !binary.isFile() ||
        binary.size < 100_000_000
      ) {
        throw new Error(
          "Chromium extraction produced an incomplete binary",
        );
      }

      if (!readyExisted) {
        await writeFile(
          READY,
          "Chromium 153 initialization completed\n",
          { flag: "wx" },
        );
      }

      return executablePath;
    } catch (error) {
      /*
       * Remove only files this initialization could have
       * created while holding the exclusive initialization
       * lock. Never remove a pre-existing installation.
       */
      if (!binaryExisted) {
        try {
          await rm(BINARY, { force: true });
          await rm(READY, { force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Chromium initialization and cleanup failed",
          );
        }
      }

      throw error;
    }
  }, LOCK);
});

export function getChromiumExecutablePath():
  Promise<string> {
  return initialize();
}
