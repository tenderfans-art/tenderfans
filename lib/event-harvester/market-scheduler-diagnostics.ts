import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";

type Identity = { workId: string; stepId: string; attempt: number };
type State = {
  identity: Identity;
  startedAt: number;
  phase: string;
  phaseStartedAt: number;
  renewalStartedAt: number | null;
  active: boolean;
};
const storage = new AsyncLocalStorage<State>();
const instanceId = randomUUID();
let activeExecutions = 0;
const mib = (bytes: number) => Math.round(bytes / 1048576);

function emit(state: State, event: string, extra = {}) {
  try {
    const now = Date.now();
    console.info("[market-scheduler-diagnostic]", JSON.stringify({
      event, at: new Date(now).toISOString(), instanceId, pid: process.pid,
      workId: state.identity.workId, stepId: state.identity.stepId,
      sdkAttempt: state.identity.attempt, phase: state.phase,
      phaseMs: now - state.phaseStartedAt, workMs: now - state.startedAt,
      renewalPendingMs: state.renewalStartedAt === null
        ? null : now - state.renewalStartedAt,
      activeExecutionsInProcess: activeExecutions,
      processRssMiB: mib(process.memoryUsage().rss),
      inlineStepSetting: process.env.WORKFLOW_MAX_INLINE_STEPS ?? "SDK default",
      ...extra,
    }));
  } catch {
    // Diagnostics must never change processing or ownership outcomes.
  }
}

export function markMarketSchedulerPhase(phase: string) {
  const state = storage.getStore();
  if (!state?.active) return;
  emit(state, "phase-finished");
  state.phase = phase;
  state.phaseStartedAt = Date.now();
  emit(state, "phase-started");
}

export function markMarketSchedulerRenewal(event: "start" | "end") {
  const state = storage.getStore();
  if (!state?.active) return;
  if (event === "start") state.renewalStartedAt = Date.now();
  emit(state, `lease-renewal-${event}`);
  if (event === "end") state.renewalStartedAt = null;
}

async function resources(state: State) {
  const values = await Promise.allSettled([
    statfs(tmpdir()),
    readFile("/sys/fs/cgroup/memory.current", "utf8"),
    readFile("/sys/fs/cgroup/memory.max", "utf8"),
  ]);
  const extra: Record<string, number> = {};
  if (values[0].status === "fulfilled") {
    extra.tmpFreeMiB = mib(values[0].value.bavail * values[0].value.bsize);
  }
  for (const [index, key] of [[1, "containerMemoryMiB"], [2, "containerMemoryLimitMiB"]] as const) {
    const value = values[index];
    if (value.status !== "fulfilled") continue;
    const bytes = Number(value.value);
    if (Number.isFinite(bytes) && bytes > 0) extra[key] = mib(bytes);
  }
  if (state.active) emit(state, "resources", extra);
}

export async function withMarketSchedulerDiagnostics<T>(
  identity: Identity,
  operation: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const state: State = {
    identity, startedAt: now, phase: "executor-start", phaseStartedAt: now,
    renewalStartedAt: null, active: true,
  };
  return storage.run(state, async () => {
    activeExecutions++;
    emit(state, "execution-started");
    let sampling = false;
    const sample = () => {
      if (sampling) return;
      sampling = true;
      void resources(state).catch(() => {}).finally(() => { sampling = false; });
    };
    sample();
    const timer = setInterval(() => { emit(state, "heartbeat"); sample(); }, 30_000);
    timer.unref();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
      emit(state, "execution-ended");
      state.active = false;
      activeExecutions--;
    }
  });
}
