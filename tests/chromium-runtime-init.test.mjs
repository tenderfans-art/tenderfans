import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

const execFileAsync = promisify(execFile);

const helperSource = readFileSync(
  "lib/event-harvester/first-party/chromium-initialization.ts",
  "utf8",
);

const runtimeSource = readFileSync(
  "lib/event-harvester/first-party/chromium-runtime.ts",
  "utf8",
);

const browserSource = readFileSync(
  "lib/event-harvester/first-party/browser-transport.ts",
  "utf8",
);

const facebookSource = readFileSync(
  "lib/event-harvester/first-party/facebook-events.ts",
  "utf8",
);

const compiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

async function fixture(operation) {
  const directory = await mkdtemp(
    join(tmpdir(), "tf-chromium-test-"),
  );

  try {
    return await operation(directory);
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
}

test("all browser launch sites use one shared initializer", () => {
  assert.equal(
    browserSource.match(
      /await getChromiumExecutablePath\(\)/g,
    )?.length,
    2,
  );

  assert.equal(
    facebookSource.match(
      /await getChromiumExecutablePath\(\)/g,
    )?.length,
    1,
  );

  assert.equal(
    runtimeSource.match(
      /await Chromium\.executablePath\(\)/g,
    )?.length,
    1,
  );

  assert.match(runtimeSource, /singleFlight/);
  assert.match(runtimeSource, /withFilesystemInitLock/);
});

test("shared initialization is single-flight and retries failures", async () => {
  const module = { exports: {} };

  new Function(
    "module",
    "exports",
    "require",
    compiled,
  )(module, module.exports, require);

  const { singleFlight } = module.exports;
  let attempts = 0;

  const initialize = singleFlight(async () => {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 20));

    if (attempts === 1) {
      throw new Error("simulated extraction failure");
    }

    return "/test/chromium";
  });

  const first = await Promise.allSettled([
    initialize(),
    initialize(),
    initialize(),
  ]);

  assert.equal(attempts, 1);
  assert.ok(first.every((entry) => entry.status === "rejected"));

  const second = await Promise.all([
    initialize(),
    initialize(),
  ]);

  assert.equal(attempts, 2);
  assert.deepEqual(second, [
    "/test/chromium",
    "/test/chromium",
  ]);
});

test("filesystem lock serializes independent Node processes", async () => {
  await fixture(async (directory) => {
    const helper = join(directory, "initializer.cjs");
    const worker = join(directory, "worker.cjs");
    const lock = join(directory, "chromium.lock");
    const eventsFile = join(directory, "events.log");

    await writeFile(helper, compiled);

    await writeFile(worker, `
const { appendFile } = require("node:fs/promises");
const {
  withFilesystemInitLock,
} = require("./initializer.cjs");

const [lock, events, id] = process.argv.slice(2);

withFilesystemInitLock(async () => {
  await appendFile(events, id + ":start\\n");

  await new Promise(resolve => setTimeout(resolve, 80));

  await appendFile(events, id + ":end\\n");
}, lock).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
`);

    await Promise.all(
      ["a", "b", "c"].map((id) =>
        execFileAsync(process.execPath, [
          worker,
          lock,
          eventsFile,
          id,
        ]),
      ),
    );

    const events = (
      await readFile(eventsFile, "utf8")
    ).trim().split("\n");

    assert.equal(events.length, 6);

    for (let index = 0; index < events.length; index += 2) {
      const start = events[index];
      const end = events[index + 1];

      assert.match(start, /^[abc]:start$/);
      assert.equal(
        end,
        start.replace(":start", ":end"),
      );
    }
  });
});

test("failed initialization releases only its own lock", async () => {
  await fixture(async (directory) => {
    const module = { exports: {} };

    new Function(
      "module",
      "exports",
      "require",
      compiled,
    )(module, module.exports, require);

    const { withFilesystemInitLock } = module.exports;
    const lock = join(directory, "chromium.lock");

    await assert.rejects(
      withFilesystemInitLock(async () => {
        throw new Error("extraction failed");
      }, lock),
      /extraction failed/,
    );

    assert.equal(
      await withFilesystemInitLock(
        async () => "recovered",
        lock,
      ),
      "recovered",
    );

    /*
     * A lock owned by somebody else must not be removed
     * merely because our wait period elapsed.
     */
    await mkdir(lock);

    await assert.rejects(
      withFilesystemInitLock(
        async () => "unsafe",
        lock,
        30,
      ),
      /lock remained occupied/,
    );
  });
});
