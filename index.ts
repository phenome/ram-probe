import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { startCollector, type RawCollectorSample } from "./src/collector.ts";
import { LogWriter } from "./src/logging.ts";
import {
  CONFIG,
  FAILURE_BASELINE,
  HEALTHY_BASELINE,
  METRIC_CAVEATS,
  METRIC_DEFINITIONS,
  SCHEMA_VERSION,
  compareSample,
  emptyWarningState,
  rankProcesses,
  updateWarnings,
  type CheckpointEvent,
  type CollectorErrorEvent,
  type Comparisons,
  type EventBase,
  type ProbeEvent,
  type ProcessRankings,
  type ProcessSample,
  type Sample,
  type SessionEndEvent,
  type SessionStartEvent,
  type SourceHealth,
  type Sources,
  type WarningEvent,
  type WarningState,
} from "./src/model.ts";
import { createDashboard, type DashboardController, type DashboardEvent, type DashboardSnapshot } from "./src/ui.ts";

const args = Bun.argv.slice(2);
const uniqueArgs = new Set(args);
const once = uniqueArgs.has("--once");
const fresh = uniqueArgs.has("--fresh");
if (args.some((argument) => argument !== "--once" && argument !== "--fresh") || uniqueArgs.size !== args.length) {
  console.error("Usage: bun run index.ts [--once] [--fresh]");
  process.exitCode = 1;
} else {
  await main(once, fresh);
}

async function main(once: boolean, fresh: boolean): Promise<void> {
  const sessionId = crypto.randomUUID();
  const sessionStarted = performance.now();
  const logger = new LogWriter();
  let loggingHealth: SourceHealth = {
    state: "ok",
    latencyMs: null,
    ageMs: 0,
    exitCode: null,
    errorCode: null,
    message: null,
  };
  try {
    await logger.start();
  } catch (error) {
    loggingHealth = {
      state: "error",
      latencyMs: null,
      ageMs: null,
      exitCode: null,
      errorCode: "log-start",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const latestLoad = fresh ? { event: null, note: null } : await logger.loadLatest();
  const restoredHistory = fresh ? [] : await logger.loadRecentSamples();
  const priorFullEvent = latestLoad.event?.kind === "checkpoint" || latestLoad.event?.kind === "warning" ? latestLoad.event : null;
  const restoredLatest = priorFullEvent?.sample ?? restoredHistory.at(-1) ?? null;
  const initialHistory = restoredLatest
    ? restoredHistory.map((sample) => ({
      ...sample,
      monotonicMs: restoredLatest.monotonicMs - Math.max(0, Date.parse(restoredLatest.timestampUtc) - Date.parse(sample.timestampUtc)),
    }))
    : restoredHistory;
  let previousCheckpointSample = priorFullEvent?.sample ?? null;
  let previousCheckpointTimestampUtc = priorFullEvent?.timestampUtc ?? null;
  const collector = startCollector();
  const terminalAbort = new AbortController();
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();
  const dashboardEvents: DashboardEvent[] = [];
  let sequence = 0;
  let previous: Sample | null = restoredLatest;
  let latestProcesses: readonly ProcessSample[] = priorFullEvent?.sample.processes ?? [];
  let latestDisplays: Sample["displays"] = restoredLatest?.displays ?? [];
  let lastSources: Sources = restoredLatest?.sources ?? {};
  let history: Sample[] = initialHistory;
  let rankings: ProcessRankings | null = priorFullEvent?.rankings ?? null;
  let warnings: WarningState = priorFullEvent?.warnings ?? emptyWarningState();
  let lastCheckpointMonotonic: number | null = null;
  let latestComparisons: Comparisons | null = null;
  let restoredNeedsRebase = history.length > 0 || previous !== null;
  let snapshot: DashboardSnapshot = {
    sessionId,
    latest: restoredLatest,
    history,
    rankings,
    warnings,
    events: dashboardEvents,
    checkpointTimestampUtc: previousCheckpointTimestampUtc,
  };
  let shutdownPromise: Promise<void> | null = null;

  const eventFields = (kind: string, timestampUtc: string, monotonicMs: number, intervalMs: number, sources: Sources): EventBase => ({
    schemaVersion: SCHEMA_VERSION,
    kind,
    sessionId,
    sequence: ++sequence,
    timestampUtc,
    monotonicMs,
    intervalMs,
    sources,
  });

  const addDashboardEvent = (level: DashboardEvent["level"], source: string, message: string, timestampUtc = new Date().toISOString()): void => {
    dashboardEvents.push({ id: `${sessionId}:${sequence}:${dashboardEvents.length}`, timestampUtc, level, source, message });
    if (dashboardEvents.length > 500) dashboardEvents.shift();
  };

  const publish = (latest: Sample | null = snapshot.latest): void => {
    snapshot = {
      sessionId,
      latest,
      history,
      rankings,
      warnings,
      events: [...dashboardEvents],
      checkpointTimestampUtc: previousCheckpointTimestampUtc,
    };
    for (const listener of listeners) listener(snapshot);
  };

  const writeEvent = async (event: ProbeEvent): Promise<boolean> => {
    const written = await logger.append(event);
    if (!written) {
      if (loggingHealth.state !== "error") addDashboardEvent("error", "logging", "Log write failed; queued record retained for retry", event.timestampUtc);
      loggingHealth = {
        state: "error",
        latencyMs: null,
        ageMs: null,
        exitCode: null,
        errorCode: "log-write",
        message: "Record retained for retry",
      };
    } else if (loggingHealth.state === "error") {
      loggingHealth = { state: "ok", latencyMs: null, ageMs: 0, exitCode: null, errorCode: null, message: null };
      addDashboardEvent("info", "logging", "Log writer recovered", event.timestampUtc);
    }
    return written;
  };

  const mergedSources = (incoming: Sources, intervalMs: number): Sources => {
    const merged: Sources = {};
    for (const [name, health] of Object.entries(lastSources)) {
      merged[name] = incoming[name] ?? { ...health, ageMs: (health.ageMs ?? 0) + intervalMs };
    }
    Object.assign(merged, incoming, { logging: loggingHealth });
    lastSources = merged;
    return merged;
  };

  const previousCheckpointComparisons = (sample: Sample, comparisons: Comparisons): Comparisons => {
    if (!previousCheckpointSample) return comparisons;
    const checkpointComparison = compareSample(sample, previousCheckpointSample, []);
    return Object.fromEntries(Object.entries(comparisons).map(([metric, comparison]) => [metric, {
      ...comparison,
      previousCheckpointDelta: checkpointComparison[metric as keyof Comparisons].previousDelta,
    }])) as Comparisons;
  };

  const sessionStart: SessionStartEvent = {
    ...eventFields("session-start", new Date().toISOString(), 0, 0, { logging: loggingHealth }),
    kind: "session-start",
    machine: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      architecture: arch(),
      logicalProcessors: cpus().length,
      totalPhysicalBytes: totalmem(),
    },
    runtime: { bun: Bun.version, typescript: "5", pid: process.pid, freshStart: fresh ? 1 : 0 },
    config: CONFIG,
    baselines: { healthy: HEALTHY_BASELINE, failure: FAILURE_BASELINE },
    metricCaveats: METRIC_CAVEATS,
    metricDefinitions: METRIC_DEFINITIONS,
    containsSensitiveCommandLines: true,
  };
  await writeEvent(sessionStart);
  addDashboardEvent("info", "session", `Started ${sessionId}`, sessionStart.timestampUtc);

  if (latestLoad.note) {
    const note: CollectorErrorEvent = {
      ...eventFields("collector-error", new Date().toISOString(), performance.now() - sessionStarted, 0, { logging: loggingHealth }),
      kind: "collector-error",
      source: "logging",
      errorCode: "previous-checkpoint-note",
      message: latestLoad.note,
    };
    await writeEvent(note);
    addDashboardEvent("info", "logging", latestLoad.note, note.timestampUtc);
  }
  if (fresh) addDashboardEvent("info", "session", "Fresh start requested", sessionStart.timestampUtc);
  else if (restoredLatest) addDashboardEvent("info", "session", `Restored ${history.length} recent samples`, sessionStart.timestampUtc);
  publish(restoredLatest);

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await collector.stop(reason);
      const timestampUtc = new Date().toISOString();
      if (
        snapshot.latest
        && latestComparisons
        && rankings
        && previousCheckpointSample?.timestampUtc !== snapshot.latest.timestampUtc
      ) {
        const checkpoint: CheckpointEvent = {
          ...eventFields("checkpoint", timestampUtc, performance.now() - sessionStarted, snapshot.latest.intervalMs, lastSources),
          kind: "checkpoint",
          sample: snapshot.latest,
          comparisons: latestComparisons,
          rankings,
          warnings,
          previousCheckpoint: previousCheckpointSample && previousCheckpointTimestampUtc
            ? { timestampUtc: previousCheckpointTimestampUtc, comparisons: latestComparisons }
            : null,
          metricCaveats: METRIC_CAVEATS,
          containsSensitiveCommandLines: true,
        };
        await writeEvent(checkpoint);
      }
      const end: SessionEndEvent = {
        ...eventFields("session-end", timestampUtc, performance.now() - sessionStarted, 0, lastSources),
        kind: "session-end",
        reason,
        durationMs: performance.now() - sessionStarted,
      };
      addDashboardEvent("info", "session", `Stopped: ${reason}`, timestampUtc);
      await writeEvent(end);
      try {
        await logger.close();
      } catch (error) {
        addDashboardEvent("error", "logging", error instanceof Error ? error.message : String(error), timestampUtc);
      }
      terminalAbort.abort();
    })();
    return shutdownPromise;
  };

  const controller: DashboardController = {
    signal: terminalAbort.signal,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shutdown,
  };

  const processRaw = async (raw: RawCollectorSample): Promise<CheckpointEvent | null> => {
    if (raw.processes) latestProcesses = raw.processes;
    if (raw.processInventoryFresh) latestDisplays = raw.displays;
    if (restoredNeedsRebase) {
      const currentTimestampMs = Date.parse(raw.timestampUtc);
      const rebase = (stored: Sample): Sample => ({
        ...stored,
        monotonicMs: raw.monotonicMs - Math.max(0, currentTimestampMs - Date.parse(stored.timestampUtc)),
      });
      history = history.map(rebase);
      if (previous) previous = rebase(previous);
      restoredNeedsRebase = false;
    }
    const sources = mergedSources(raw.sources, raw.intervalMs);
    const sample: Sample = {
      timestampUtc: raw.timestampUtc,
      monotonicMs: raw.monotonicMs,
      intervalMs: raw.intervalMs,
      system: raw.system,
      nvidia: raw.nvidia,
      displays: latestDisplays,
      processes: latestProcesses,
      processInventoryFresh: raw.processInventoryFresh,
      sources,
    };
    let comparisons = compareSample(sample, previous, history);
    comparisons = previousCheckpointComparisons(sample, comparisons);
    latestComparisons = comparisons;
    history.push(sample);
    while (history.length > 3_600 || sample.monotonicMs - history[0]!.monotonicMs > CONFIG.historyWindowMs) history.shift();
    if (raw.processInventoryFresh) rankings = rankProcesses(latestProcesses, history);
    rankings ??= rankProcesses(latestProcesses, history);
    const warningUpdate = updateWarnings(warnings, sample, comparisons);
    warnings = warningUpdate.state;
    const compactSample: Sample = { ...sample, processes: [] };
    await writeEvent({
      ...eventFields("sample", sample.timestampUtc, sample.monotonicMs, sample.intervalMs, sources),
      kind: "sample",
      sample: compactSample,
      comparisons,
      warnings,
    });
    for (const issue of raw.issues) {
      const event: CollectorErrorEvent = {
        ...eventFields("collector-error", sample.timestampUtc, sample.monotonicMs, sample.intervalMs, sources),
        kind: "collector-error",
        source: issue.source,
        errorCode: issue.errorCode,
        message: issue.message,
      };
      await writeEvent(event);
      addDashboardEvent(issue.errorCode === "collector-exit" ? "error" : "warn", issue.source, issue.message, sample.timestampUtc);
    }
    for (const change of warningUpdate.changes) {
      const event: WarningEvent = {
        ...eventFields("warning", sample.timestampUtc, sample.monotonicMs, sample.intervalMs, sources),
        kind: "warning",
        change,
        sample,
        comparisons,
        rankings,
        warnings,
        metricCaveats: METRIC_CAVEATS,
        containsSensitiveCommandLines: true,
      };
      await writeEvent(event);
      addDashboardEvent(change.transition === "clear" ? "info" : "warn", "warning", `${change.transition}: ${change.warning.code}`, sample.timestampUtc);
    }

    let checkpoint: CheckpointEvent | null = null;
    if (lastCheckpointMonotonic === null || sample.monotonicMs - lastCheckpointMonotonic >= CONFIG.checkpointIntervalMs) {
      checkpoint = {
        ...eventFields("checkpoint", sample.timestampUtc, sample.monotonicMs, sample.intervalMs, sources),
        kind: "checkpoint",
        sample,
        comparisons,
        rankings,
        warnings,
        previousCheckpoint: previousCheckpointSample && previousCheckpointTimestampUtc
          ? { timestampUtc: previousCheckpointTimestampUtc, comparisons }
          : null,
        metricCaveats: METRIC_CAVEATS,
        containsSensitiveCommandLines: true,
      };
      await writeEvent(checkpoint);
      lastCheckpointMonotonic = sample.monotonicMs;
      previousCheckpointSample = sample;
      previousCheckpointTimestampUtc = sample.timestampUtc;
      addDashboardEvent("info", "checkpoint", `Checkpoint ${sample.timestampUtc}`, sample.timestampUtc);
    }
    previous = sample;
    publish(sample);
    return checkpoint;
  };

  const onSigint = (): void => void shutdown("ctrl+c");
  process.on("SIGINT", onSigint);
  try {
    if (once) {
      for await (const raw of collector.samples) {
        const checkpoint = await processRaw(raw);
        if (checkpoint) {
          console.log(JSON.stringify(checkpoint));
          break;
        }
      }
      await shutdown("once-complete");
      return;
    }

    const dashboardTask = createDashboard(controller).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      addDashboardEvent("error", "ui", message);
      const event: CollectorErrorEvent = {
        ...eventFields("collector-error", new Date().toISOString(), performance.now() - sessionStarted, 0, lastSources),
        kind: "collector-error",
        source: "ui",
        errorCode: "tui-failure",
        message,
      };
      await writeEvent(event);
      await shutdown("tui-failure");
    });
    const collectionTask = (async () => {
      for await (const raw of collector.samples) await processRaw(raw);
      if (!terminalAbort.signal.aborted) {
        const event: CollectorErrorEvent = {
          ...eventFields("collector-error", new Date().toISOString(), performance.now() - sessionStarted, 0, lastSources),
          kind: "collector-error",
          source: "powershell",
          errorCode: "collector-exit",
          message: "PowerShell collector stopped; core metrics unavailable",
        };
        await writeEvent(event);
        addDashboardEvent("error", "powershell", event.message, event.timestampUtc);
        publish();
        await shutdown("powershell-exit");
      }
    })();
    await Promise.all([dashboardTask, collectionTask]);
  } finally {
    process.off("SIGINT", onSigint);
    await shutdownPromise;
  }
}
