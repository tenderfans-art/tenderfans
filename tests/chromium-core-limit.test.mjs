import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ts from "typescript";

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const compile = path => ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = compile("lib/event-harvester/first-party/chromium-launcher.ts");
function load(overrides = {}) {
  const exports = {};
  new Function("require", "exports", compiled)(name =>
    name === "node:fs/promises" ? { ...fs, ...overrides } : require(name), exports);
  return exports.ensureChromiumLauncher;
}
async function fixture(t, script = "#!/bin/sh\nexit 0\n") {
  const root = await fs.mkdtemp(join(tmpdir(), "tf-core-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const native = join(root, "native' $(touch INJECTED) $HOME `id`");
  await fs.writeFile(native, script, { mode: 0o700 });
  return { root, native, launcher: join(root, "tenderfans-chromium-153-no-core") };
}

test("real launcher sets both core limits to zero and preserves arguments and process identity", async t => {
  const { root, native } = await fixture(t, `#!/bin/sh
printf '%s\\n' "$(ulimit -Sc)" "$(ulimit -Hc)" "$$"
printf '%s\\0' "$@"
`);
  const launcher = await load()(native);
  const args = ["--remote-debugging-pipe", "a b", "", "'\"$HOME`id`", "line\nbreak", "*.json"];
  const running = execute(launcher, args, { cwd: root, encoding: "buffer" });
  const { stdout } = await running;
  const [soft, hard, pid, ...argumentLines] = stdout.toString().split("\n");
  assert.equal(soft, "0");
  assert.equal(hard, "0");
  assert.equal(Number(pid), running.child.pid, "exec preserves the process Playwright supervises");
  assert.deepEqual(argumentLines.join("\n").split("\0").slice(0, -1), args);
  await assert.rejects(fs.stat(join(root, "INJECTED")), { code: "ENOENT" });
});

test("launcher preserves native exit failures", async t => {
  const { native } = await fixture(t, "#!/bin/sh\nexit 17\n");
  await assert.rejects(execute(await load()(native)), { code: 17 });
});

test("concurrent initialization publishes one complete executable without leftovers or rewrites", async t => {
  const { root, native, launcher } = await fixture(t);
  const ensure = load();
  const paths = await Promise.all(Array.from({ length: 20 }, () => ensure(native)));
  assert.ok(paths.every(path => path === launcher));
  const before = await fs.stat(launcher);
  assert.equal(before.mode & 0o777, 0o700);
  assert.equal(await ensure(native), launcher);
  const after = await fs.stat(launcher);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await fs.readdir(root)).length, 2);
  await execute(launcher);
});

for (const kind of ["unknown file", "symlink", "directory", "non-executable", "writable by others"]) {
  test(`refuses an existing ${kind} and preserves its contents`, async t => {
    const { root, native, launcher } = await fixture(t);
    if (kind === "symlink") await fs.symlink(native, launcher);
    else if (kind === "directory") await fs.mkdir(launcher);
    else {
      if (kind !== "unknown file") await load()(native);
      else await fs.writeFile(launcher, "unknown existing contents", { mode: 0o700 });
      if (kind === "non-executable") await fs.chmod(launcher, 0o600);
      if (kind === "writable by others") await fs.chmod(launcher, 0o777);
    }
    const before = await fs.lstat(launcher);
    const nativeContents = await fs.readFile(native, "utf8");
    await assert.rejects(load()(native), /launcher is not verified/);
    assert.equal((await fs.lstat(launcher)).ino, before.ino);
    assert.equal(await fs.readFile(native, "utf8"), nativeContents);
    assert.equal((await fs.readdir(root)).length, 2);
    if (kind === "unknown file") assert.equal(await fs.readFile(launcher, "utf8"), "unknown existing contents");
  });
}

test("failed publication removes only its private temporary script and can retry", async t => {
  const { root, native } = await fixture(t);
  await fs.writeFile(join(root, "core.123"), "existing diagnostic evidence");
  const failure = Object.assign(Error("disk full"), { code: "ENOSPC" });
  await assert.rejects(load({ link: async () => { throw failure; } })(native), error => error === failure);
  assert.equal((await fs.readdir(root)).length, 2);
  assert.equal(await fs.readFile(join(root, "core.123"), "utf8"), "existing diagnostic evidence");
  await execute(await load()(native));
});

test("launcher failure retries without re-extracting or deleting the verified native installation", async () => {
  const exports = {};
  let extractions = 0, launchers = 0, deletes = 0;
  const initialization = {};
  new Function("require", "exports", compile("lib/event-harvester/first-party/chromium-initialization.ts"))(require, initialization);
  const failure = Error("launcher creation failed");
  new Function("require", "exports", compile("lib/event-harvester/first-party/chromium-runtime.ts"))(name => {
    if (name === "@sparticuz/chromium") return { default: { executablePath: async () => { extractions++; return "/tmp/chromium"; } } };
    if (name === "./chromium-initialization") return { ...initialization, withFilesystemInitLock: operation => operation() };
    if (name === "node:fs/promises") return {
      stat: async () => ({ isFile: () => true, size: 200_000_000 }),
      writeFile: async () => assert.fail("verified native installation should retain its marker"),
      rm: async () => { deletes++; },
    };
    if (name === "./chromium-launcher") return { ensureChromiumLauncher: async path => {
      assert.equal(path, "/tmp/chromium");
      if (++launchers === 1) throw failure;
      return "/tmp/verified-launcher";
    } };
    return require(name);
  }, exports);
  await assert.rejects(exports.getChromiumExecutablePath(), error => error === failure);
  assert.equal(await exports.getChromiumExecutablePath(), "/tmp/verified-launcher");
  assert.equal(extractions, 1);
  assert.equal(launchers, 2);
  assert.equal(deletes, 0);
});
