import { lstat, opendir, readFile, readlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

type Category = "Installation" | "Profiles" | "Artifacts" | "CoreFiles" | "OtherFiles";
const categories: Category[] = ["Installation", "Profiles", "Artifacts", "CoreFiles", "OtherFiles"];
const allocated = (entry: { blocks: number }) => entry.blocks * 512;
const mib = (bytes: number) => Math.round(bytes / 1048576 * 100) / 100;

function category(name: string, isFile: boolean): Category {
  if (/^(chromium|chromium-pack|fonts|al2023|swiftshader|libEGL\.so|libGLESv2\.so|libvk_swiftshader\.so|libvulkan\.so\.1|vk_swiftshader_icd\.json)$/.test(name)) return "Installation";
  if (/^(playwright_(chromium|firefox|webkit)dev_profile-|pw-)/.test(name)) return "Profiles";
  if (/^playwright-artifacts-/.test(name)) return "Artifacts";
  if (isFile && /^core([._-].*)?$/.test(name)) return "CoreFiles";
  return "OtherFiles";
}

/** Read-only, bounded metadata inventory. Never emits paths or file contents. */
export async function getMarketRuntimeStorageDiagnostics(): Promise<Record<string, number | boolean>> {
  const root = tmpdir();
  const bytes = Object.fromEntries(categories.map(key => [key, 0])) as Record<Category, number>;
  const visited = new Set<string>(), deleted = new Set<string>();
  const deadline = Date.now() + 2000;
  let truncated = false, errors = 0, entriesSeen = 0, processes = 0, fds = 0;
  let deletedBytes = 0, chromiumProcesses = 0, stopped = false;
  const expired = () => {
    if (stopped || Date.now() >= deadline) { truncated = true; return true; }
    return false;
  };
  const result = () => ({
    ...Object.fromEntries(categories.map(key => [`tmp${key}MiB`, mib(bytes[key])])),
    tmpDeletedOpenMiB: mib(deletedBytes), chromiumProcesses,
    tmpInventoryTruncated: truncated, tmpInventoryPartialErrors: errors,
  });
  async function* names(path: string): AsyncGenerator<string> {
    if (expired()) return;
    try {
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (expired()) return;
        yield entry.name;
      }
    } catch { errors++; }
  }
  async function walk(path: string, group: Category | undefined, depth: number): Promise<void> {
    if (expired()) return;
    if (entriesSeen >= 2000) { truncated = true; return; }
    entriesSeen++;
    try {
      const entry = await lstat(path);
      const key = `${entry.dev}:${entry.ino}`;
      if (visited.has(key)) return;
      visited.add(key);
      const assigned = group ?? category(path.slice(root.length + sep.length), entry.isFile());
      bytes[assigned] += allocated(entry);
      if (!entry.isDirectory()) return; // lstat never follows a child symlink.
      if (depth >= 8) { truncated = true; return; }
      for await (const name of names(path)) {
        if (entriesSeen >= 2000 || expired()) { truncated = true; break; }
        await walk(join(path, name), assigned, depth + 1);
      }
    } catch { errors++; }
  }
  const scan = async () => {
    let device: number;
    try {
      const rootStat = await stat(root);
      device = rootStat.dev;
      bytes.OtherFiles += allocated(rootStat);
    } catch { errors++; return; }
    for await (const name of names(root)) {
      if (entriesSeen >= 2000 || expired()) { truncated = true; break; }
      await walk(join(root, name), undefined, 0);
    }
    for await (const pid of names("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      if (processes >= 128 || expired()) { truncated = true; break; }
      processes++;
      try {
        const comm = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
        if (/^(chromium|chrome|headless_shell|chrome-headless)$/.test(comm)) chromiumProcesses++;
      } catch { errors++; }
      for await (const fd of names(`/proc/${pid}/fd`)) {
        if (!/^\d+$/.test(fd)) continue;
        if (fds >= 1024 || expired()) { truncated = true; break; }
        fds++;
        try {
          const path = `/proc/${pid}/fd/${fd}`;
          const target = await readlink(path);
          if (!target.startsWith(root + sep) || !target.endsWith(" (deleted)")) continue;
          if (expired()) return;
          const entry = await stat(path);
          const key = `${entry.dev}:${entry.ino}`;
          if (entry.nlink !== 0 || !entry.isFile() || entry.dev !== device || deleted.has(key)) continue;
          deleted.add(key);
          deletedBytes += allocated(entry);
        } catch { errors++; }
      }
      if (fds >= 1024 || expired()) { truncated = true; break; }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scan(),
      new Promise<void>(resolve => {
        timer = setTimeout(() => { stopped = true; truncated = true; resolve(); }, 2000);
        timer.unref();
      }),
    ]);
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
  return result();
}
