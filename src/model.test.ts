import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogWriter, shouldDeleteLogFile } from "./logging.ts";
import {
  compareSample,
  emptyWarningState,
  processIdentity,
  rankProcesses,
  updateWarnings,
  type ProcessSample,
  type Sample,
  type WarningState,
  type SampleEvent,
} from "./model.ts";

const GB = 1024 ** 3;
const OK_SOURCE = { state: "ok" as const, latencyMs: 1, ageMs: 0, exitCode: null, errorCode: null, message: null };

function sample(index: number, failure = false, ramOverride?: number | null): Sample {
  return {
    timestampUtc: new Date(Date.UTC(2026, 6, 15, 0, 0, index * 2)).toISOString(),
    monotonicMs: index * 2_000,
    intervalMs: 2_000,
    system: {
      totalPhysicalBytes: 32 * GB,
      availablePhysicalBytes: failure ? 1.14 * GB : 14.64 * GB,
      usedPhysicalPercent: ramOverride === undefined ? (failure ? 96.3 : 53) : ramOverride,
      committedBytes: (failure ? 75.53 : 25.06) * GB,
      commitLimitBytes: 83.11 * GB,
      pagefileAllocatedBytes: 64 * GB,
      pagefileCurrentBytes: 1 * GB,
      pagefilePeakBytes: 2 * GB,
      compressionWorkingSetBytes: 0,
      cacheBytes: 1 * GB,
      pagedPoolAllocatedBytes: (failure ? 7.68 : 1.28) * GB,
      pagedPoolResidentBytes: null,
      nonpagedPoolBytes: (failure ? 5.57 : 0.94) * GB,
      pageInputsPerSecond: 0,
      pageReadsPerSecond: 0,
      cpuHostPercent: 5,
      diskBusyPercent: 1,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
      diskQueueLength: 0,
      wddmDedicatedBytes: (failure ? 15 : 2.87) * GB,
      wddmSharedBytes: 0,
      dwmWddmBytes: (failure ? 8.2 : 1.26) * GB,
      slackWddmBytes: 0,
      vmmemWslWorkingSetBytes: 0,
      wslState: "stopped",
      herdrState: "unknown",
    },
    nvidia: [],
    displays: [],
    processes: [],
    processInventoryFresh: true,
    sources: { cim: OK_SOURCE },
  };
}

function process(pid: number, creationUtc: string, privateBytes: number | null): ProcessSample {
  return {
    identity: processIdentity(pid, creationUtc),
    pid,
    parentPid: null,
    creationUtc,
    name: "probe",
    executablePath: null,
    commandLine: null,
    privateBytes,
    privateWorkingSetBytes: privateBytes,
    workingSetBytes: privateBytes,
    cpuCorePercent: 0,
    cpuHostPercent: 0,
    ioBytesPerSecond: 0,
    threadCount: 1,
    handleCount: 1,
    wddmDedicatedBytes: null,
    wddmSharedBytes: null,
    self: false,
  };
}

function evaluate(sequence: readonly Sample[], initial: WarningState = emptyWarningState()): { state: WarningState; transitions: string[] } {
  const history: Sample[] = [];
  const transitions: string[] = [];
  let state = initial;
  let previous: Sample | null = null;
  for (const current of sequence) {
    const comparisons = compareSample(current, previous, history);
    const update = updateWarnings(state, current, comparisons);
    state = update.state;
    transitions.push(...update.changes.map((change) => `${change.transition}:${change.warning.code}`));
    history.push(current);
    previous = current;
  }
  return { state, transitions };
}

describe("warning hysteresis", () => {
  test("opens exact failure warnings only after three samples", () => {
    const healthy = evaluate([sample(0), sample(1), sample(2)]);
    expect(healthy.state.active).toEqual({});
    const failure = evaluate([sample(3, true), sample(4, true), sample(5, true)], healthy.state);
    expect(failure.transitions.sort()).toEqual([
      "open:commit",
      "open:dwm",
      "open:nonpaged-pool",
      "open:paged-pool",
      "open:ram",
      "open:wddm",
    ]);
  });

  test("clears active warnings only after three safe samples", () => {
    const opened = evaluate([sample(0, true), sample(1, true), sample(2, true)]);
    const firstTwo = evaluate([sample(3), sample(4)], opened.state);
    expect(Object.keys(firstTwo.state.active).length).toBe(6);
    const cleared = evaluate([sample(5)], firstTwo.state);
    expect(cleared.state.active).toEqual({});
    expect(cleared.transitions.every((transition) => transition.startsWith("clear:"))).toBe(true);
  });
});

test("process identity separates PID reuse", () => {
  expect(processIdentity(42, "2026-07-15T00:00:00Z")).not.toBe(processIdentity(42, "2026-07-15T01:00:00Z"));
});

test("ranking ties use PID ascending", () => {
  const rankings = rankProcesses([process(9, "a", 10), process(2, "b", 10)]);
  expect(rankings.topPrivateCommit.map((row) => row.pid)).toEqual([2, 9]);
});

test("null metrics remain unavailable", () => {
  const current = sample(0, false, null);
  current.system.availablePhysicalBytes = null;
  current.system.committedBytes = null;
  current.system.pagedPoolAllocatedBytes = null;
  current.system.nonpagedPoolBytes = null;
  current.system.wddmDedicatedBytes = null;
  current.system.wddmSharedBytes = null;
  current.system.dwmWddmBytes = null;
  const comparisons = compareSample(current, null, []);
  expect(comparisons.ramUsedPercent.current).toBeNull();
  expect(comparisons.ramUsedPercent.rolling1Minute.count).toBe(0);
  expect(evaluate([current, current, current]).state.active).toEqual({});
  expect(rankProcesses([process(1, "a", null)]).topPrivateCommit).toEqual([]);
});

test("rolling comparisons preserve extrema average and slope", () => {
  const history = [sample(0, false, 40), sample(10, false, 50), sample(20, false, 60)];
  const current = sample(30, false, 70);
  const comparisons = compareSample(current, history.at(-1)!, history);
  expect(comparisons.ramUsedPercent.previousDelta).toBe(10);
  expect(comparisons.ramUsedPercent.rolling5Minutes).toMatchObject({ count: 4, min: 40, max: 70, average: 55 });
  expect(comparisons.ramUsedPercent.rolling5Minutes.slopePerMinute).toBeCloseTo(30, 8);
});

test("retention deletes only old matching daily logs", () => {
  const now = Date.parse("2026-07-15T12:00:00Z");
  const old = Date.parse("2026-07-01T12:00:00Z");
  expect(shouldDeleteLogFile("ram-probe-2026-07-01.ndjson", old, now)).toBe(true);
  expect(shouldDeleteLogFile("ram-probe-2026-07-01-3.ndjson", old, now)).toBe(true);
  expect(shouldDeleteLogFile("unrelated-2026-07-01.ndjson", old, now)).toBe(false);
});

test("recent persisted samples restore inside history window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ram-probe-"));
  const now = new Date("2026-07-15T12:00:00Z");
  const writer = new LogWriter({ directory, now: () => now });
  await writer.start();
  try {
    const stored = [
      { ...sample(0), timestampUtc: "2026-07-15T08:00:00.000Z" },
      { ...sample(1), timestampUtc: "2026-07-15T11:30:00.000Z" },
    ];
    for (let index = 0; index < stored.length; index++) {
      const current = stored[index]!;
      const event: SampleEvent = {
        schemaVersion: 1,
        kind: "sample",
        sessionId: "restore-test",
        sequence: index + 1,
        timestampUtc: current.timestampUtc,
        monotonicMs: current.monotonicMs,
        intervalMs: current.intervalMs,
        sources: current.sources,
        sample: current,
        comparisons: compareSample(current, null, []),
        warnings: emptyWarningState(),
      };
      expect(await writer.append(event)).toBe(true);
    }
    expect((await writer.loadRecentSamples()).map((current) => current.timestampUtc)).toEqual(["2026-07-15T11:30:00.000Z"]);
  } finally {
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
