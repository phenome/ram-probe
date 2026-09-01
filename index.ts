import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { startCollector, type RawCollectorSample } from "./src/collector.ts";
import { LogWriter, mergeSampleHistory } from "./src/logging.ts";
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
  const latestLoadPromise = fresh ? Promise.resolve({ event: null, note: null }) : logger.loadLatest();
  let previousCheckpointSample: Sample | null = null;
  let previousCheckpointTimestampUtc: string | null = null;
  let dashboardCheckpointTimestampUtc: string | null = null;
  const collector = startCollector();
  const terminalAbort = new AbortController();
  const listeners = new Set<(snapshot: DashboardSnapshot) => void>();
  const dashboardEvents: DashboardEvent[] = [];
  let sequence = 0;
  let previous: Sample | null = null;
  let latestProcesses: readonly ProcessSample[] = [];
  let latestDisplays: Sample["displays"] = [];
  let lastSources: Sources = {};
  let liveHistory: Sample[] = [];
  let persistedHistory: Sample[] = [];
  let history: Sample[] = [];
  let rankings: ProcessRankings | null = null;
  let warnings: WarningState = emptyWarningState();
  let lastCheckpointMonotonic: number | null = null;
  let latestComparisons: Comparisons | null = null;
  let historyStatus = {
    requestedWindowMs: 0,
    loadedWindowMs: 0,
    loading: false,
    error: null as string | null,
  };
  let historyLoadPromise: Promise<void> | null = null;
  let snapshot: DashboardSnapshot = {
    sessionId,
    latest: null,
    history,
    historyStatus,
    rankings,
    warnings,
    events: dashboardEvents,
    checkpointTimestampUtc: dashboardCheckpointTimestampUtc,
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
      historyStatus,
      rankings,
      warnings,
      events: [...dashboardEvents],
      checkpointTimestampUtc: dashboardCheckpointTimestampUtc,
    };
    for (const listener of listeners) listener(snapshot);
  };

  const rebasePersistedHistory = (timestampUtc: string, monotonicMs: number): void => {
    const anchorTimestampMs = Date.parse(timestampUtc);
    persistedHistory = persistedHistory.map((sample) => ({
      ...sample,
      monotonicMs: monotonicMs + Date.parse(sample.timestampUtc) - anchorTimestampMs,
    }));
  };

  const rebuildHistory = (): void => {
    const merged = mergeSampleHistory(persistedHistory, liveHistory, Date.now() - CONFIG.historyWindowMs);
    persistedHistory = merged.persisted;
    liveHistory = merged.live;
    history = merged.history;
  };

  const loadRequestedHistory = async (): Promise<void> => {
    while (historyStatus.loadedWindowMs < historyStatus.requestedWindowMs) {
      const windowMs = historyStatus.requestedWindowMs;
      try {
        const loaded = await logger.loadRecentSamples(windowMs);
        persistedHistory.push(...loaded);
        const anchor = liveHistory.at(-1);
        if (anchor) rebasePersistedHistory(anchor.timestampUtc, anchor.monotonicMs);
        rebuildHistory();
        historyStatus = {
          ...historyStatus,
          loadedWindowMs: Math.max(historyStatus.loadedWindowMs, windowMs),
          error: null,
        };
        publish();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        historyStatus = { ...historyStatus, loading: false, error: message };
        addDashboardEvent("error", "history", `History load failed: ${message}`);
        publish();
        return;
      }
    }
    historyStatus = { ...historyStatus, loading: false };
    publish();
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

  publish();
  const priorStateTask = latestLoadPromise.then(async (latestLoad) => {
    const prior = latestLoad.event?.kind === "checkpoint" || latestLoad.event?.kind === "warning" ? latestLoad.event : null;
    if (lastCheckpointMonotonic === null && prior) {
      previousCheckpointSample = prior.sample;
      previousCheckpointTimestampUtc = prior.timestampUtc;
    }
    if (!latestLoad.note) return;
    const note: CollectorErrorEvent = {
      ...eventFields("collector-error", new Date().toISOString(), performance.now() - sessionStarted, 0, { logging: loggingHealth }),
      kind: "collector-error",
      source: "logging",
      errorCode: "previous-checkpoint-note",
      message: latestLoad.note,
    };
    await writeEvent(note);
    addDashboardEvent("info", "logging", latestLoad.note, note.timestampUtc);
    publish();
  });

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await priorStateTask;
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
    requestHistory(windowMs: number) {
      if (!Number.isFinite(windowMs) || windowMs <= 0) return;
      const requestedWindowMs = Math.min(CONFIG.historyWindowMs, windowMs);
      historyStatus = {
        ...historyStatus,
        requestedWindowMs: Math.max(historyStatus.requestedWindowMs, requestedWindowMs),
      };
      if (fresh) {
        historyStatus = {
          ...historyStatus,
          loadedWindowMs: historyStatus.requestedWindowMs,
          loading: false,
          error: null,
        };
        publish();
        return;
      }
      if (historyStatus.requestedWindowMs <= historyStatus.loadedWindowMs) {
        publish();
        return;
      }
      historyStatus = { ...historyStatus, loading: true };
      if (!historyLoadPromise) {
        historyLoadPromise = Promise.resolve().then(loadRequestedHistory).finally(() => {
          historyLoadPromise = null;
        });
      }
      publish();
    },
    async restartGraphicsStack(): Promise<void> {
      try {
        if (process.platform !== "win32") throw new Error("Graphics restart is only supported on Windows");
        const command = String.raw`
try {
  $reset = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -Verb RunAs -ArgumentList @('/F', '/IM', 'dwm.exe') -WindowStyle Hidden -Wait -PassThru
  exit $reset.ExitCode
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;
        const child = Bun.spawn(
          ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
          { stdout: "pipe", stderr: "pipe", windowsHide: true },
        );
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(stderr.trim() || `DWM restart exited with ${exitCode}`);
        addDashboardEvent("info", "graphics", "Restarted Desktop Window Manager");
      } catch (error) {
        addDashboardEvent("error", "graphics", `Graphics restart failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      publish();
    },
    async killProcess(identity: string): Promise<void> {
      const target = latestProcesses.find((candidate) => candidate.identity === identity);
      try {
        if (!target) throw new Error("Process is no longer present in the latest inventory");
        if (target.self || target.pid === process.pid) throw new Error("Refusing to terminate ram-probe");
        if (!target.creationUtc) throw new Error("Process creation time is unavailable; identity cannot be verified");
        const command = String.raw`
$targetPid = [int]$env:RAM_PROBE_TARGET_PID
$expectedCreation = $env:RAM_PROBE_TARGET_CREATED
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction Stop
if ($null -eq $target) { throw "Process $targetPid is no longer running" }
$actualCreation = $target.CreationDate.ToUniversalTime().ToString('o')
if ($actualCreation -ne $expectedCreation) { throw "Process identity changed; refusing to terminate PID $targetPid" }
Stop-Process -Id $targetPid -Force -ErrorAction Stop
`;
        const child = Bun.spawn(
          ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
          {
            env: {
              ...process.env,
              RAM_PROBE_TARGET_PID: String(target.pid),
              RAM_PROBE_TARGET_CREATED: target.creationUtc,
            },
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          },
        );
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(stderr.trim() || `Process termination exited with ${exitCode}`);
        addDashboardEvent("info", "process", `Killed ${target.name} (PID ${target.pid})`);
      } catch (error) {
        addDashboardEvent("error", "process", `Kill failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      publish();
    },
    shutdown,
  };

  const processRaw = async (raw: RawCollectorSample): Promise<CheckpointEvent | null> => {
    await priorStateTask;
    if (raw.processes) latestProcesses = raw.processes;
    if (raw.processInventoryFresh) latestDisplays = raw.displays;
    if (!liveHistory.length && persistedHistory.length) {
      rebasePersistedHistory(raw.timestampUtc, raw.monotonicMs);
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
    let comparisons = compareSample(sample, previous, liveHistory);
    comparisons = previousCheckpointComparisons(sample, comparisons);
    latestComparisons = comparisons;
    liveHistory.push(sample);
    rebuildHistory();
    if (raw.processInventoryFresh) rankings = rankProcesses(latestProcesses, liveHistory);
    rankings ??= rankProcesses(latestProcesses, liveHistory);
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
      dashboardCheckpointTimestampUtc = sample.timestampUtc;
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
