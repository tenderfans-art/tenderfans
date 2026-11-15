import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync("lib/event-harvester/market-runtime-storage-diagnostics.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(root, overrides = {}, globals = {}) {
  const exports = {};
  new Function("require", "exports", "Date", "setTimeout", "clearTimeout", compiled)(name => {
    if (name === "node:os") return { tmpdir: () => root };
    if (name === "node:fs/promises") return { ...fs, ...overrides };
    return require(name);
  }, exports, globals.Date ?? Date, globals.setTimeout ?? setTimeout, globals.clearTimeout ?? clearTimeout);
  return exports.getMarketRuntimeStorageDiagnostics;
}
const directory = names => ({ async *[Symbol.asyncIterator]() { for (const name of names) yield { name }; } });
const metadata = (values = {}) => ({ dev: 7, ino: 1, blocks: 0, nlink: 1,
  isFile: () => true, isDirectory: () => false, ...values });
const fixture = async t => {
  const root = await fs.mkdtemp(join(tmpdir(), "tf-storage-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

test("inventories allocated blocks, categories and directory metadata without following symlinks", async t => {
  const root = await fixture(t), outside = await fixture(t);
  for (const name of ["fonts", "playwright_chromiumdev_profile-test", "playwright-artifacts-test"]) await fs.mkdir(join(root, name));
  for (const name of ["chromium", "fonts/face", "playwright_chromiumdev_profile-test/cache", "playwright-artifacts-test/artifact", "core.123", "unknown"]) {
    await fs.writeFile(join(root, name), Buffer.alloc(8192));
  }
  const sparse = await fs.open(join(root, "sparse"), "w");
  await sparse.truncate(1024 * 1024 * 1024); await sparse.close();
  await fs.writeFile(join(outside, "private-source-url"), Buffer.alloc(1048576));
  await fs.symlink(outside, join(root, "outside"));
  const inventory = await load(root, { opendir: path => path === "/proc" ? Promise.resolve(directory([])) : fs.opendir(path) })();
  assert.equal(inventory.tmpInventoryTruncated, false);
  assert.equal(inventory.tmpInventoryPartialErrors, 0);
  assert.ok(inventory.tmpInstallationMiB > 0);
  assert.ok(inventory.tmpProfilesMiB > 0);
  assert.ok(inventory.tmpArtifactsMiB > 0);
  assert.equal(inventory.tmpCoreFilesMiB, 0.01);
  assert.ok(inventory.tmpOtherFilesMiB < 0.1, "sparse apparent size and symlink target are excluded");
  assert.ok(!JSON.stringify(inventory).includes("private-source-url"));
  assert.ok(!JSON.stringify(inventory).includes(root));
});

test("deduplicates deleted-open regular files across processes and excludes other devices", async () => {
  const calls = [];
  const inventory = await load("/inventory", {
    opendir: async path => directory(path === "/proc" ? ["1", "2", "self"] : path.endsWith("/fd") ? ["3", "4", "5", "6", "7", "8", "9"] : []),
    stat: async path => path === "/inventory" ? metadata() : metadata({ ino: path.endsWith("/4") ? 22 : 11,
      nlink: path.endsWith("/5") ? 1 : 0, dev: path.endsWith("/6") ? 99 : 7, blocks: 2048,
      isFile: () => !path.endsWith("/7") }),
    readlink: async path => path.endsWith("/8") ? "/elsewhere/private (deleted)" : path.endsWith("/9")
      ? "/inventory/still-linked" : "/inventory/.org.chromium.Chromium.secret (deleted)",
    readFile: async path => { calls.push(path); return path.includes("/1/") ? "chromium\n" : "node\n"; },
  })();
  assert.equal(inventory.tmpDeletedOpenMiB, 2);
  assert.equal(inventory.chromiumProcesses, 1);
  assert.equal(inventory.tmpInventoryPartialErrors, 0);
  assert.deepEqual(calls, ["/proc/1/comm", "/proc/2/comm"]);
  assert.ok(!JSON.stringify(inventory).includes("secret"));
});

test("permission failures remain visible rather than claiming a complete zero inventory", async () => {
  const inventory = await load("/inventory", {
    stat: async () => metadata(),
    opendir: async path => {
      if (path.endsWith("/fd")) throw Object.assign(Error("denied"), { code: "EACCES" });
      return directory(path === "/proc" ? ["1"] : []);
    },
    readFile: async () => { throw Object.assign(Error("denied"), { code: "EACCES" }); },
  })();
  assert.equal(inventory.tmpDeletedOpenMiB, 0);
  assert.equal(inventory.tmpInventoryPartialErrors, 2);
});

test("bounds inventory entries, process scans and file descriptors", async () => {
  let checked = 0;
  const inventory = await load("/inventory", {
    stat: async () => metadata(), lstat: async () => metadata({ ino: ++checked }),
    opendir: async path => directory(path === "/inventory" ? Array.from({ length: 2001 }, (_, i) => `file${i}`) : []),
  })();
  assert.equal(checked, 2000); assert.equal(inventory.tmpInventoryTruncated, true);
  let commReads = 0;
  const processes = await load("/inventory", {
    stat: async () => metadata(),
    opendir: async path => directory(path === "/proc" ? Array.from({ length: 129 }, (_, i) => `${i + 1}`) : []),
    readFile: async () => { commReads++; return "node"; },
  })();
  assert.equal(commReads, 128); assert.equal(processes.tmpInventoryTruncated, true);
  let linkReads = 0;
  const descriptors = await load("/inventory", {
    stat: async () => metadata(), readFile: async () => "node",
    opendir: async path => directory(path === "/proc" ? ["1"] : path.endsWith("/fd") ? Array.from({ length: 1025 }, (_, i) => `${i}`) : []),
    readlink: async () => { linkReads++; return "socket:[1]"; },
  })();
  assert.equal(linkReads, 1024); assert.equal(descriptors.tmpInventoryTruncated, true);
});

test("bounds directory depth and returns partial results when the deadline expires", async () => {
  let deepest = 0;
  const inventory = await load("/inventory", {
    stat: async () => metadata(),
    lstat: async path => { deepest = Math.max(deepest, path.split("/").length - 3); return metadata({ ino: path.length, isDirectory: () => true }); },
    opendir: async path => directory(path.startsWith("/inventory") ? ["deep"] : []),
  })();
  assert.equal(deepest, 8); assert.equal(inventory.tmpInventoryTruncated, true);
  let timeout;
  const hanging = load("/inventory", { stat: async () => new Promise(() => {}) }, {
    setTimeout: callback => { timeout = callback; return { unref() {} }; }, clearTimeout() {},
  })();
  timeout();
  assert.equal((await hanging).tmpInventoryTruncated, true);
});

test("a late filesystem response cannot restart scanning after the deadline", async () => {
  let timeout, release, openCalls = 0, statCalls = 0;
  const delayedDirectory = new Promise(resolve => { release = resolve; });
  const running = load("/inventory", {
    stat: async () => metadata(),
    opendir: async () => { openCalls++; return delayedDirectory; },
    lstat: async () => { statCalls++; return metadata(); },
  }, {
    setTimeout: callback => { timeout = callback; return { unref() {} }; }, clearTimeout() {},
  })();
  await new Promise(setImmediate);
  timeout();
  assert.equal((await running).tmpInventoryTruncated, true);
  release(directory(["private"]));
  await new Promise(setImmediate);
  assert.equal(openCalls, 1);
  assert.equal(statCalls, 0);
});
