// Session-conflict deferral tests cover busy-session cron survival (#165162):
// a claim rejected because a competing writer owns the session is a deferral,
// not an execution failure, so it must not spend the retry budget, must keep
// its failure counters and backoff semantics, and the occurrence executes
// once the writer releases — including across a service restart.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService, type CronEvent } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-session-conflict-",
});
const atMs = Date.parse("2025-12-13T00:00:02.000Z");

function sessionConflictResult() {
  return {
    status: "error" as const,
    error: 'Session "agent:main:main" changed while starting work. Retry.',
    admissionDisposition: "session-conflict" as const,
    executionStarted: false as const,
  };
}

const mainJob = (overrides: Partial<CronJobCreate> = {}): CronJobCreate => ({
  name: "session-conflict",
  enabled: true,
  schedule: { kind: "at", at: new Date(atMs).toISOString() },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "do it" },
  delivery: { mode: "announce" },
  ...overrides,
});

async function fixture(options: Partial<Pick<CronServiceDeps, "runIsolatedAgentJob">> = {}) {
  const store = await makeStorePath();
  // The clock starts one second before the one-shot slot so timestamps stay
  // exact: the deferral tick lands at atMs and the backoff adds its schedule
  // entry on top of the same mock clock reading.
  const clock = createGatewaySchedulerClock(atMs - 1000);
  const finished = createDeferred<CronEvent>();
  const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(
    options.runIsolatedAgentJob ?? (async () => sessionConflictResult()),
  );
  // NonNullable: the dep fields are optional, and vi.fn requires a callable.
  const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
    async (params) => {
      await params.onDeliverySettled({ delivered: true, status: "delivered" });
    },
  );
  const runCronFailureRepair = vi.fn<NonNullable<CronServiceDeps["runCronFailureRepair"]>>(
    async () => {},
  );
  const baseDeps: CronServiceDeps = {
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    nowMs: () => clock.clock.now(),
    runIsolatedAgentJob,
    sendCronFailureAlert,
    runCronFailureRepair,
    onEvent: (event: CronEvent) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  };
  const services: CronService[] = [];
  const startService = async () => {
    const cron = new CronService({ ...baseDeps });
    services.push(cron);
    await cron.start();
    return cron;
  };
  const cron = await startService();
  const cleanup = async () => {
    for (const service of services.toReversed()) {
      await service.status();
      service.stop();
    }
    await store.cleanup();
    resetSystemEventsForTest();
  };
  return {
    cron,
    deps: baseDeps,
    runIsolatedAgentJob,
    sendCronFailureAlert,
    runCronFailureRepair,
    clock,
    storePath: store.storePath,
    startService,
    cleanup,
  };
}

describe("CronService session-conflict deferrals", () => {
  it("defers a one-shot behind an active writer without spending the retry budget", async () => {
    const { cron, runIsolatedAgentJob, clock, cleanup } = await fixture();
    try {
      const job = await cron.add(mainJob());
      expect(job.state.nextRunAtMs).toBe(atMs);
      await clock.advanceTo(atMs);
      await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledOnce());

      // The claim was rejected as a deferral: no retry budget spent, prior
      // failure counters preserved, the one-shot stays enabled, and the
      // occurrence retries on the advancing conflict backoff — the first
      // deferral lands exactly on the 15-second schedule entry.
      const deferredState = cron.getJob(job.id)?.state;
      expect(deferredState?.lastRunStatus).toBe("error");
      expect(deferredState?.consecutiveErrors ?? 0).toBe(0);
      expect(deferredState?.consecutiveSessionConflicts).toBe(1);
      expect(deferredState?.nextRunAtMs).toBe(atMs + 15_000);
      expect(cron.getJob(job.id)?.enabled).toBe(true);

      // Survives past the ordinary transient retry budget (3) while busy,
      // with the backoff schedule advancing per deferral.
      const expectedBackoffs = [30_000, 60_000, 2 * 60_000, 5 * 60_000];
      let previousNextRunAtMs = atMs + 15_000;
      for (const [attempt, backoff] of expectedBackoffs.entries()) {
        const conflicts = 2 + attempt;
        await clock.advanceTo(previousNextRunAtMs);
        await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2 + attempt));
        await vi.waitFor(() => {
          const state = cron.getJob(job.id)?.state;
          expect(state?.consecutiveSessionConflicts).toBe(conflicts);
          expect(state?.consecutiveErrors ?? 0).toBe(0);
          expect(state?.nextRunAtMs).toBe(previousNextRunAtMs + backoff);
        });
        previousNextRunAtMs += backoff;
      }
      expect(cron.getJob(job.id)?.enabled).toBe(true);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(5);

      // The writer releases: the next attempt claims and executes, and the
      // one-shot success disables the job to prevent a tight loop (#11452).
      runIsolatedAgentJob.mockResolvedValue({ status: "ok" as const });
      await clock.advanceTo(previousNextRunAtMs);
      await vi.waitFor(() => {
        const state = cron.getJob(job.id)?.state;
        expect(state?.lastRunStatus ?? state?.lastStatus).toBe("ok");
      });
      expect(cron.getJob(job.id)?.state.consecutiveSessionConflicts).toBe(0);
      expect(cron.getJob(job.id)?.enabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("does not auto-disable a recurring job across repeated session-conflict deferrals", async () => {
    const { cron, runIsolatedAgentJob, clock, cleanup } = await fixture();
    try {
      const job = await cron.add(
        mainJob({ schedule: { kind: "every", everyMs: 60_000, anchorMs: atMs } }),
      );
      const firstRunAtMs = job.state.nextRunAtMs;
      expect(firstRunAtMs).toBeDefined();
      await clock.advanceTo(firstRunAtMs!);
      // Past the ten-failure auto-disable limit, the deferral streak must not
      // have counted toward it: the job stays enabled with no error streak.
      for (let expectedCalls = 1; expectedCalls <= 12; expectedCalls += 1) {
        await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(expectedCalls));
        expect(cron.getJob(job.id)?.state.consecutiveErrors ?? 0).toBe(0);
        expect(cron.getJob(job.id)?.enabled).toBe(true);
        if (expectedCalls < 12) {
          await clock.advanceBy(60_000);
        }
      }
      expect(cron.getJob(job.id)?.state.consecutiveSessionConflicts).toBe(12);
      expect(cron.getJob(job.id)?.enabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("keeps failure history and resumes cadence across a restart after a deferral", async () => {
    const { cron, runIsolatedAgentJob, clock, startService, cleanup } = await fixture();
    try {
      // The runner fails five times with a real provider error, then the
      // session turns busy: the deferral must not touch the failure streak.
      runIsolatedAgentJob.mockImplementation(async () => {
        if (runIsolatedAgentJob.mock.calls.length <= 5) {
          return { status: "error" as const, error: "provider returned 500" };
        }
        return sessionConflictResult();
      });
      const job = await cron.add(
        mainJob({ schedule: { kind: "every", everyMs: 60_000, anchorMs: atMs } }),
      );
      for (let failures = 1; failures <= 5; failures += 1) {
        await cron.run(job.id, "force");
        await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(failures));
      }
      expect(cron.getJob(job.id)?.state.consecutiveErrors).toBe(5);
      await cron.run(job.id, "force");
      await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(6));
      const stateAfterDeferral = cron.getJob(job.id)?.state;
      expect(stateAfterDeferral?.consecutiveErrors).toBe(5);
      expect(stateAfterDeferral?.consecutiveSessionConflicts).toBe(1);

      // Restart on the same store: the persisted deferral must not extend the
      // execution-error backoff (five errors would otherwise block a one-minute
      // job for an hour), so the recurring job resumes its cadence.
      await cron.status();
      cron.stop();
      runIsolatedAgentJob.mockResolvedValue({ status: "ok" as const });
      const restarted = await startService();
      const resumedJob = restarted.getJob(job.id);
      expect(resumedJob?.state.consecutiveErrors).toBe(5);
      expect(resumedJob?.state.consecutiveSessionConflicts).toBe(1);
      await clock.advanceBy(60_000);
      await vi.waitFor(() => {
        const state = restarted.getJob(job.id)?.state;
        expect(state?.lastRunStatus ?? state?.lastStatus).toBe("ok");
      });
      expect(restarted.getJob(job.id)?.enabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("does not open a failure incident or alert on a fresh job's deferral", async () => {
    const {
      cron,
      runIsolatedAgentJob,
      clock,
      sendCronFailureAlert,
      runCronFailureRepair,
      cleanup,
    } = await fixture();
    try {
      const job = await cron.add(
        mainJob({
          schedule: { kind: "every", everyMs: 60_000, anchorMs: atMs },
          failureAlert: { after: 1 },
        }),
      );
      await clock.advanceTo(atMs);
      await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(cron.getJob(job.id)?.state.consecutiveSessionConflicts).toBe(1),
      );

      // Contention with zero prior failures is not an incident: the deferral
      // bypasses failure notification finalization entirely.
      const state = cron.getJob(job.id)?.state;
      expect(state?.failureAlertIncident).toBeUndefined();
      expect(state?.consecutiveErrors ?? 0).toBe(0);
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      expect(runCronFailureRepair).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("does not alert or request repair for contention on a previously failing job", async () => {
    const { cron, runIsolatedAgentJob, sendCronFailureAlert, runCronFailureRepair, cleanup } =
      await fixture();
    try {
      // Two genuine provider failures reach the alert threshold; the third
      // attempt hits a busy session instead of a real execution.
      runIsolatedAgentJob.mockImplementation(async () => {
        if (runIsolatedAgentJob.mock.calls.length <= 2) {
          return { status: "error" as const, error: "provider returned 500" };
        }
        return sessionConflictResult();
      });
      const job = await cron.add(
        mainJob({
          schedule: { kind: "every", everyMs: 60_000, anchorMs: atMs },
          failureAlert: { after: 2 },
        }),
      );
      for (let failures = 1; failures <= 2; failures += 1) {
        await cron.run(job.id, "force");
        await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(failures));
      }
      // The genuine failure streak alerts exactly once at the threshold.
      await vi.waitFor(() => expect(sendCronFailureAlert).toHaveBeenCalledOnce());
      const stateBeforeDeferral = cron.getJob(job.id)?.state;
      expect(stateBeforeDeferral?.consecutiveErrors).toBe(2);
      expect(stateBeforeDeferral?.failureAlertIncident).toBeDefined();

      // Contention spends no retained failure history: no second alert, no
      // repair request, and the existing incident stays untouched until a
      // real outcome resolves or extends it.
      await cron.run(job.id, "force");
      await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(3));
      await vi.waitFor(() =>
        expect(cron.getJob(job.id)?.state.consecutiveSessionConflicts).toBe(1),
      );
      const state = cron.getJob(job.id)?.state;
      expect(state?.consecutiveErrors).toBe(2);
      expect(state?.failureAlertIncident).toMatchObject({ scope: "run" });
      expect(state?.failureAlertIncident?.repair).toBeUndefined();
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(runCronFailureRepair).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
