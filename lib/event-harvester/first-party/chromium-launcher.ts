import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && error.code === code;
}

/** Disable kernel core dumps in Chromium and its children, without changing Node's limits. */
export async function ensureChromiumLauncher(executablePath: string): Promise<string> {
  const launcher = join(dirname(executablePath), "tenderfans-chromium-153-no-core");
  const quotedPath = "'" + executablePath.replace(/'/g, "'\"'\"'") + "'";
  const script = `#!/bin/sh\nulimit -c 0 || exit 1\nexec ${quotedPath} "$@"\n`;

  async function verify(): Promise<boolean> {
    let metadata;
    try {
      metadata = await lstat(launcher);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }

    // Never execute or replace an unknown file or follow a launcher symlink.
    if (!metadata.isFile() || metadata.size !== Buffer.byteLength(script) ||
      (metadata.mode & 0o777) !== 0o700 || await readFile(launcher, "utf8") !== script) {
      throw new Error("Chromium core-limit launcher is not verified; refusing to use or replace it");
    }
    return true;
  }

  if (await verify()) return launcher;

  const temporary = launcher + "." + randomUUID();
  const handle = await open(temporary, "wx", 0o700);
  try {
    try {
      await handle.writeFile(script);
    } finally {
      await handle.close();
    }

    // Publish only a fully written, closed inode. A concurrent initializer may
    // win, but cannot cause an overwrite or expose a partially written script.
    try {
      await link(temporary, launcher);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }

    if (!await verify()) throw new Error("Chromium core-limit launcher disappeared during initialization");
    return launcher;
  } finally {
    // This process exclusively created this temporary file. Existing files,
    // browser installations and diagnostic core files are never removed here.
    await unlink(temporary);
  }
}
