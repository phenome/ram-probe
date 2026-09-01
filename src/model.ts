export const SCHEMA_VERSION = 2 as const;

export const CONFIG = Object.freeze({
  sampleIntervalMs: 2_000,
  processIntervalMs: 10_000,
  checkpointIntervalMs: 600_000,
  historyWindowMs: 18_000_000,
  retentionDays: 7,
  maxLogFileBytes: 52_428_800,
  topProcessCount: 15,
  warningOpenSamples: 3,
  warningClearSamples: 3,
});

const GB = 1024 ** 3;

export interface Baseline {
  ramUsedPercent: number;
  availablePhysicalBytes: number;
  committedBytes: number;
  commitLimitBytes?: number;
  pagedPoolBytes: number;
  nonpagedPoolBytes: number;
  wddmRawBytes: number;
  dwmWddmRawBytes: number;
}

export const HEALTHY_BASELINE: Readonly<Baseline> = Object.freeze({
  ramUsedPercent: 53,
  availablePhysicalBytes: 14.64 * GB,
  committedBytes: 25.06 * GB,
  pagedPoolBytes: 1.28 * GB,
  nonpagedPoolBytes: 0.94 * GB,
  wddmRawBytes: 2.87 * GB,
  dwmWddmRawBytes: 1.26 * GB,
});

export const FAILURE_BASELINE: Readonly<Baseline> = Object.freeze({
  ramUsedPercent: 96.3,
  availablePhysicalBytes: 1.14 * GB,
  committedBytes: 75.53 * GB,
  commitLimitBytes: 83.11 * GB,
  pagedPoolBytes: 7.68 * GB,
  nonpagedPoolBytes: 5.57 * GB,
  wddmRawBytes: 15 * GB,
  dwmWddmRawBytes: 8.2 * GB,
});

export const METRIC_CAVEATS = Object.freeze([
  "wddmRawBytes preserves Dedicated Usage + Shared Usage accounting; it may exceed adapter capacity and is not physical residency.",
  "gpuCommittedBytes is WDDM Total Committed; gpuResidentBytes is WDDM Local Usage + Non Local Usage.",
  "NVIDIA telemetry is adapter-wide VRAM residency and may not sum exactly with per-process WDDM residency.",
  "Process command lines are full and unredacted in checkpoint and warning records.",
]);

export const METRIC_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  bytes: "Base-2 byte counts; dashboard formats GiB as GB for compact display.",
  percent: "Percentages range from 0 to 100 unless a raw process core percentage exceeds one logical core.",
  processCpu: "cpuCorePercent may exceed 100; cpuHostPercent is divided by logical processor count.",
  rates: "Per-second rates come from Windows formatted performance counters over the recorded interval.",
  gpuMemory: "Raw WDDM accounting, committed GPU memory, and resident GPU memory are recorded separately.",
  unavailable: "Unavailable measurements are null, never copied forward or replaced with zero.",
});

export type SourceState = "ok" | "partial" | "unavailable" | "error";

export interface SourceHealth {
  state: SourceState;
  latencyMs: number | null;
  ageMs: number | null;
  exitCode: number | null;
  errorCode: string | null;
  message: string | null;
}

export type Sources = Record<string, SourceHealth>;

export interface ProcessSample {
  identity: string;
  pid: number;
  parentPid: number | null;
  creationUtc: string | null;
  name: string;
  executablePath: string | null;
  commandLine: string | null;
  privateBytes: number | null;
  privateWorkingSetBytes: number | null;
  workingSetBytes: number | null;
  cpuCorePercent: number | null;
  cpuHostPercent: number | null;
  ioBytesPerSecond: number | null;
  threadCount: number | null;
  handleCount: number | null;
  wddmRawBytes: number | null;
  gpuCommittedBytes: number | null;
  gpuResidentBytes: number | null;
  self: boolean;
}

export function processIdentity(pid: number, creationUtc: string | null): string {
  return `${pid}:${creationUtc ?? "unknown"}`;
}

export interface SystemSample {
  totalPhysicalBytes: number | null;
  availablePhysicalBytes: number | null;
  usedPhysicalPercent: number | null;
  committedBytes: number | null;
  commitLimitBytes: number | null;
  pagefileAllocatedBytes: number | null;
  pagefileCurrentBytes: number | null;
  pagefilePeakBytes: number | null;
  compressionWorkingSetBytes: number | null;
  cacheBytes: number | null;
  pagedPoolAllocatedBytes: number | null;
  pagedPoolResidentBytes: number | null;
  nonpagedPoolBytes: number | null;
  pageInputsPerSecond: number | null;
  pageReadsPerSecond: number | null;
  cpuHostPercent: number | null;
  diskBusyPercent: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  diskQueueLength: number | null;
  wddmRawBytes: number | null;
  gpuCommittedBytes: number | null;
  gpuResidentBytes: number | null;
  dwmWddmRawBytes: number | null;
  slackWddmRawBytes: number | null;
  vmmemWslWorkingSetBytes: number | null;
  wslState: string | null;
  herdrState: string | null;
}

export interface NvidiaAdapterSample {
  uuid: string;
  name: string | null;
  totalVramBytes: number | null;
  usedVramBytes: number | null;
  freeVramBytes: number | null;
  utilizationPercent: number | null;
  temperatureCelsius: number | null;
  powerWatts: number | null;
  graphicsClockMhz: number | null;
  memoryClockMhz: number | null;
  pState: string | null;
  pciBusId: string | null;
  driverVersion: string | null;
}

export interface DisplayDeviceSample {
  name: string;
  status: string | null;
  errorCode: number | null;
  informational: boolean;
}

export interface Sample {
  timestampUtc: string;
  monotonicMs: number;
  intervalMs: number;
  system: SystemSample;
  nvidia: readonly NvidiaAdapterSample[];
  displays: readonly DisplayDeviceSample[];
  processes: readonly ProcessSample[];
  processInventoryFresh: boolean;
  sources: Sources;
}

export interface MetricWindow {
  count: number;
  min: number | null;
  max: number | null;
  average: number | null;
  slopePerMinute: number | null;
}

export interface MetricComparison {
  current: number | null;
  previousDelta: number | null;
  startupDelta: number | null;
  previousCheckpointDelta: number | null;
  healthyBaselineDelta: number | null;
  failureBaselineDelta: number | null;
  delta10Minutes: number | null;
  valid10MinutePoints: number;
  rolling1Minute: MetricWindow;
  rolling5Minutes: MetricWindow;
  rolling30Minutes: MetricWindow;
}

export type ComparisonMetric =
  | "ramUsedPercent"
  | "availablePhysicalBytes"
  | "committedBytes"
  | "pagedPoolBytes"
  | "nonpagedPoolBytes"
  | "wddmRawBytes"
  | "dwmWddmRawBytes";

export type Comparisons = Record<ComparisonMetric, MetricComparison>;

export type RankingDimension =
  | "privateCommit"
  | "privateWorkingSet"
  | "workingSet"
  | "cpu"
  | "io"
  | "gpuCommitted"
  | "gpuResident"
  | "wddmRaw"
  | "growth";

export interface RankedProcess extends ProcessSample {
  metricValue: number;
  growth60SecondsBytes: number | null;
}

export interface ProcessGroup {
  name: string;
  count: number;
  privateBytes: number;
  privateWorkingSetBytes: number;
  workingSetBytes: number;
  cpuHostPercent: number;
  ioBytesPerSecond: number;
  gpuCommittedBytes: number;
  gpuResidentBytes: number;
  wddmRawBytes: number;
  growth60SecondsBytes: number;
}

export interface ProcessRankings {
  topPrivateCommit: readonly RankedProcess[];
  topPrivateWorkingSet: readonly RankedProcess[];
  topWorkingSet: readonly RankedProcess[];
  topCpu: readonly RankedProcess[];
  topIo: readonly RankedProcess[];
  topGpuCommitted: readonly RankedProcess[];
  topGpuResident: readonly RankedProcess[];
  topWddmRaw: readonly RankedProcess[];
  topGrowth: readonly RankedProcess[];
  byExecutable: readonly ProcessGroup[];
}

export type WarningSeverity = "warning" | "critical";
export type WarningTransition = "open" | "severity-change" | "clear";

export type WarningCode =
  | "ram"
  | "commit"
  | "nonpaged-pool"
  | "paged-pool"
  | "wddm-raw"
  | "dwm-raw"
  | "slack-raw"
  | "nvidia-vram"
  | "active-paging"
  | "nonpaged-growth"
  | "wddm-raw-growth"
  | "display-device";

export interface ActiveWarning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  openedAtUtc: string;
  updatedAtUtc: string;
  value: number | null;
}

export interface WarningCounter {
  violatingSamples: number;
  safeSamples: number;
  pendingSeverity: WarningSeverity | null;
}

export interface WarningState {
  active: Partial<Record<WarningCode, ActiveWarning>>;
  counters: Partial<Record<WarningCode, WarningCounter>>;
}

export interface WarningChange {
  transition: WarningTransition;
  warning: ActiveWarning;
}

export interface WarningUpdate {
  state: WarningState;
  changes: readonly WarningChange[];
}

export interface EventBase {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: string;
  sessionId: string;
  sequence: number;
  timestampUtc: string;
  monotonicMs: number;
  intervalMs: number;
  sources: Sources;
}

export interface SessionStartEvent extends EventBase {
  kind: "session-start";
  machine: Record<string, string | number | null>;
  runtime: Record<string, string | number | null>;
  config: typeof CONFIG;
  baselines: { healthy: Baseline; failure: Baseline };
  metricCaveats: readonly string[];
  metricDefinitions: Readonly<Record<string, string>>;
  containsSensitiveCommandLines: true;
}

export interface SampleEvent extends EventBase {
  kind: "sample";
  sample: Sample;
  comparisons: Comparisons;
  warnings: WarningState;
}

export interface CheckpointEvent extends EventBase {
  kind: "checkpoint";
  sample: Sample;
  comparisons: Comparisons;
  rankings: ProcessRankings;
  warnings: WarningState;
  previousCheckpoint: { timestampUtc: string; comparisons: Comparisons } | null;
  metricCaveats: readonly string[];
  containsSensitiveCommandLines: true;
}

export interface WarningEvent extends EventBase {
  kind: "warning";
  change: WarningChange;
  sample: Sample;
  comparisons: Comparisons;
  rankings: ProcessRankings;
  warnings: WarningState;
  metricCaveats: readonly string[];
  containsSensitiveCommandLines: true;
}

export interface CollectorErrorEvent extends EventBase {
  kind: "collector-error";
  source: string;
  errorCode: string;
  message: string;
}

export interface SessionEndEvent extends EventBase {
  kind: "session-end";
  reason: string;
  durationMs: number;
}

export type ProbeEvent =
  | SessionStartEvent
  | SampleEvent
  | CheckpointEvent
  | WarningEvent
  | CollectorErrorEvent
  | SessionEndEvent;

export function emptyWarningState(): WarningState {
  return { active: {}, counters: {} };
}

const COMPARISON_METRICS: readonly ComparisonMetric[] = [
  "ramUsedPercent",
  "availablePhysicalBytes",
  "committedBytes",
  "pagedPoolBytes",
  "nonpagedPoolBytes",
  "wddmRawBytes",
  "dwmWddmRawBytes",
];

function metricValue(sample: Sample, metric: ComparisonMetric): number | null {
  const system = sample.system;
  switch (metric) {
    case "ramUsedPercent": return system.usedPhysicalPercent;
    case "availablePhysicalBytes": return system.availablePhysicalBytes;
    case "committedBytes": return system.committedBytes;
    case "pagedPoolBytes": return system.pagedPoolAllocatedBytes;
    case "nonpagedPoolBytes": return system.nonpagedPoolBytes;
    case "wddmRawBytes": return system.wddmRawBytes;
    case "dwmWddmRawBytes": return system.dwmWddmRawBytes;
  }
}

function baselineValue(baseline: Baseline, metric: ComparisonMetric): number | null {
  switch (metric) {
    case "ramUsedPercent": return baseline.ramUsedPercent;
    case "availablePhysicalBytes": return baseline.availablePhysicalBytes;
    case "committedBytes": return baseline.committedBytes;
    case "pagedPoolBytes": return baseline.pagedPoolBytes;
    case "nonpagedPoolBytes": return baseline.nonpagedPoolBytes;
    case "wddmRawBytes": return baseline.wddmRawBytes;
    case "dwmWddmRawBytes": return baseline.dwmWddmRawBytes;
  }
}

function delta(current: number | null, baseline: number | null | undefined): number | null {
  return current === null || baseline === null || baseline === undefined ? null : current - baseline;
}

function windowStats(current: Sample, history: readonly Sample[], metric: ComparisonMetric, durationMs: number): MetricWindow {
  const start = current.monotonicMs - durationMs;
  const points = [...history, current]
    .filter((sample) => sample.monotonicMs >= start && sample.monotonicMs <= current.monotonicMs)
    .map((sample) => ({ time: sample.monotonicMs, value: metricValue(sample, metric) }))
    .filter((point): point is { time: number; value: number } => point.value !== null);
  if (!points.length) return { count: 0, min: null, max: null, average: null, slopePerMinute: null };
  const values = points.map((point) => point.value);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanTime = points.reduce((sum, point) => sum + point.time, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const centeredTime = point.time - meanTime;
    numerator += centeredTime * (point.value - average);
    denominator += centeredTime ** 2;
  }
  return {
    count: points.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average,
    slopePerMinute: denominator ? (numerator / denominator) * 60_000 : null,
  };
}

export function compareSample(current: Sample, previous: Sample | null, history: readonly Sample[]): Comparisons {
  const startup = history[0] ?? current;
  const checkpoint = [...history].reverse().find((sample) => current.monotonicMs - sample.monotonicMs >= CONFIG.checkpointIntervalMs) ?? null;
  const tenMinutePoints = [...history, current].filter(
    (sample) => sample.monotonicMs >= current.monotonicMs - CONFIG.checkpointIntervalMs,
  );
  return Object.fromEntries(COMPARISON_METRICS.map((metric) => {
    const value = metricValue(current, metric);
    const tenMinuteValues = tenMinutePoints
      .map((sample) => metricValue(sample, metric))
      .filter((item): item is number => item !== null);
    return [metric, {
      current: value,
      previousDelta: delta(value, previous ? metricValue(previous, metric) : null),
      startupDelta: delta(value, metricValue(startup, metric)),
      previousCheckpointDelta: delta(value, checkpoint ? metricValue(checkpoint, metric) : null),
      healthyBaselineDelta: delta(value, baselineValue(HEALTHY_BASELINE, metric)),
      failureBaselineDelta: delta(value, baselineValue(FAILURE_BASELINE, metric)),
      delta10Minutes: tenMinuteValues.length > 1 ? value! - tenMinuteValues[0]! : null,
      valid10MinutePoints: tenMinuteValues.length,
      rolling1Minute: windowStats(current, history, metric, 60_000),
      rolling5Minutes: windowStats(current, history, metric, 300_000),
      rolling30Minutes: windowStats(current, history, metric, 1_800_000),
    }];
  })) as Comparisons;
}


function ranked(
  processes: readonly ProcessSample[],
  growthByIdentity: ReadonlyMap<string, number>,
  value: (process: ProcessSample) => number | null,
): readonly RankedProcess[] {
  return processes
    .map((process) => ({ ...process, metricValue: value(process), growth60SecondsBytes: growthByIdentity.get(process.identity) ?? null }))
    .filter((process): process is RankedProcess => process.metricValue !== null)
    .sort((left, right) => right.metricValue - left.metricValue || left.pid - right.pid)
    .slice(0, CONFIG.topProcessCount);
}

export function rankProcesses(processes: readonly ProcessSample[], history: readonly Sample[] = []): ProcessRankings {
  const latest = history.at(-1);
  const past = latest
    ? [...history].reverse().find((sample) => latest.monotonicMs - sample.monotonicMs >= 60_000)
    : undefined;
  const pastPrivate = new Map(past?.processes.map((process) => [process.identity, process.privateBytes] as const) ?? []);
  const growthByIdentity = new Map<string, number>();
  for (const process of processes) {
    const old = pastPrivate.get(process.identity);
    if (old !== undefined && old !== null && process.privateBytes !== null) {
      growthByIdentity.set(process.identity, process.privateBytes - old);
    }
  }

  const groups = new Map<string, ProcessGroup>();
  for (const process of processes) {
    const name = process.name.toLowerCase();
    const group = groups.get(name) ?? {
      name,
      count: 0,
      privateBytes: 0,
      privateWorkingSetBytes: 0,
      workingSetBytes: 0,
      cpuHostPercent: 0,
      ioBytesPerSecond: 0,
      gpuCommittedBytes: 0,
      gpuResidentBytes: 0,
      wddmRawBytes: 0,
      growth60SecondsBytes: 0,
    };
    group.count++;
    group.privateBytes += process.privateBytes ?? 0;
    group.privateWorkingSetBytes += process.privateWorkingSetBytes ?? 0;
    group.workingSetBytes += process.workingSetBytes ?? 0;
    group.cpuHostPercent += process.cpuHostPercent ?? 0;
    group.ioBytesPerSecond += process.ioBytesPerSecond ?? 0;
    group.gpuCommittedBytes += process.gpuCommittedBytes ?? 0;
    group.gpuResidentBytes += process.gpuResidentBytes ?? 0;
    group.wddmRawBytes += process.wddmRawBytes ?? 0;
    group.growth60SecondsBytes += growthByIdentity.get(process.identity) ?? 0;
    groups.set(name, group);
  }

  return {
    topPrivateCommit: ranked(processes, growthByIdentity, (process) => process.privateBytes),
    topPrivateWorkingSet: ranked(processes, growthByIdentity, (process) => process.privateWorkingSetBytes),
    topWorkingSet: ranked(processes, growthByIdentity, (process) => process.workingSetBytes),
    topCpu: ranked(processes, growthByIdentity, (process) => process.cpuHostPercent),
    topIo: ranked(processes, growthByIdentity, (process) => process.ioBytesPerSecond),
    topGpuCommitted: ranked(processes, growthByIdentity, (process) => process.gpuCommittedBytes),
    topGpuResident: ranked(processes, growthByIdentity, (process) => process.gpuResidentBytes),
    topWddmRaw: ranked(processes, growthByIdentity, (process) => process.wddmRawBytes),
    topGrowth: ranked(processes, growthByIdentity, (process) => growthByIdentity.get(process.identity) ?? null),
    byExecutable: [...groups.values()].sort((left, right) => right.privateBytes - left.privateBytes || left.name.localeCompare(right.name)),
  };
}

interface WarningCandidate {
  severity: WarningSeverity;
  value: number | null;
  message: string;
}

function severityAt(value: number | null, warning: number, critical: number): WarningSeverity | null {
  if (value === null) return null;
  if (value >= critical) return "critical";
  return value >= warning ? "warning" : null;
}

function availableSeverity(value: number | null): WarningSeverity | null {
  if (value === null) return null;
  if (value < 1.5 * GB) return "critical";
  return value < 2.5 * GB ? "warning" : null;
}

function maxSeverity(...values: (WarningSeverity | null)[]): WarningSeverity | null {
  return values.includes("critical") ? "critical" : values.includes("warning") ? "warning" : null;
}

function candidates(sample: Sample, comparisons: Comparisons): Partial<Record<WarningCode, WarningCandidate>> {
  const system = sample.system;
  const commitPercent = system.committedBytes !== null && system.commitLimitBytes
    ? system.committedBytes / system.commitLimitBytes * 100
    : null;
  const ramSeverity = maxSeverity(severityAt(system.usedPhysicalPercent, 90, 95), availableSeverity(system.availablePhysicalBytes));
  const commitSeverity = severityAt(commitPercent, 80, 90);
  const nvidiaPercent = sample.nvidia
    .map((adapter) => adapter.usedVramBytes !== null && adapter.totalVramBytes
      ? adapter.usedVramBytes / adapter.totalVramBytes * 100
      : null)
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0] ?? null;
  const output: Partial<Record<WarningCode, WarningCandidate>> = {};
  const add = (code: WarningCode, severity: WarningSeverity | null, value: number | null, message: string): void => {
    if (severity) output[code] = { severity, value, message };
  };
  add("ram", ramSeverity, system.usedPhysicalPercent, "Physical memory pressure");
  add("commit", commitSeverity, commitPercent, "Commit charge pressure");
  add("nonpaged-pool", severityAt(system.nonpagedPoolBytes, 3 * GB, 5 * GB), system.nonpagedPoolBytes, "Nonpaged pool pressure");
  add("paged-pool", severityAt(system.pagedPoolAllocatedBytes, 5 * GB, 7 * GB), system.pagedPoolAllocatedBytes, "Paged pool pressure");
  const wddmRaw = comparisons.wddmRawBytes.current;
  add("wddm-raw", severityAt(wddmRaw, 8 * GB, 12 * GB), wddmRaw, "Raw WDDM accounting pressure");
  add("dwm-raw", severityAt(system.dwmWddmRawBytes, 4 * GB, 7 * GB), system.dwmWddmRawBytes, "Desktop Window Manager raw WDDM pressure");
  add("slack-raw", severityAt(system.slackWddmRawBytes, 5 * GB, 20 * GB), system.slackWddmRawBytes, "Slack raw WDDM pressure");
  add("nvidia-vram", severityAt(nvidiaPercent, 90, 97), nvidiaPercent, "NVIDIA VRAM pressure");
  if ((ramSeverity || commitSeverity) && (system.pageInputsPerSecond ?? 0) >= 100) {
    add("active-paging", "warning", system.pageInputsPerSecond, "Active paging under memory pressure");
  }
  if (comparisons.nonpagedPoolBytes.valid10MinutePoints >= 5) {
    add("nonpaged-growth", severityAt(comparisons.nonpagedPoolBytes.delta10Minutes, 0.5 * GB, Number.POSITIVE_INFINITY), comparisons.nonpagedPoolBytes.delta10Minutes, "Nonpaged pool grew at least 0.5 GB in 10 minutes");
  }
  if (comparisons.wddmRawBytes.valid10MinutePoints >= 5) {
    add("wddm-raw-growth", severityAt(comparisons.wddmRawBytes.delta10Minutes, 2 * GB, Number.POSITIVE_INFINITY), comparisons.wddmRawBytes.delta10Minutes, "Raw WDDM accounting grew at least 2 GB in 10 minutes");
  }
  const badDisplay = sample.displays.find((display) => !display.informational && display.errorCode !== null && display.errorCode !== 0);
  if (badDisplay) add("display-device", "warning", badDisplay.errorCode, `${badDisplay.name} reports device error ${badDisplay.errorCode}`);
  return output;
}

export function updateWarnings(state: WarningState, sample: Sample, comparisons: Comparisons): WarningUpdate {
  const next: WarningState = {
    active: { ...state.active },
    counters: { ...state.counters },
  };
  const changes: WarningChange[] = [];
  const currentCandidates = candidates(sample, comparisons);
  const codes = new Set<WarningCode>([
    ...(Object.keys(state.active) as WarningCode[]),
    ...(Object.keys(state.counters) as WarningCode[]),
    ...(Object.keys(currentCandidates) as WarningCode[]),
  ]);

  for (const code of codes) {
    const candidate = currentCandidates[code];
    const active = next.active[code];
    const counter = next.counters[code] ?? { violatingSamples: 0, safeSamples: 0, pendingSeverity: null };
    if (!candidate) {
      counter.violatingSamples = 0;
      counter.pendingSeverity = null;
      counter.safeSamples++;
      if (active && counter.safeSamples >= CONFIG.warningClearSamples) {
        changes.push({ transition: "clear", warning: { ...active, updatedAtUtc: sample.timestampUtc } });
        delete next.active[code];
        delete next.counters[code];
      } else {
        next.counters[code] = counter;
      }
      continue;
    }

    counter.safeSamples = 0;
    if (counter.pendingSeverity === candidate.severity) counter.violatingSamples++;
    else {
      counter.pendingSeverity = candidate.severity;
      counter.violatingSamples = 1;
    }
    if (!active && counter.violatingSamples >= CONFIG.warningOpenSamples) {
      const warning: ActiveWarning = {
        code,
        severity: candidate.severity,
        message: candidate.message,
        openedAtUtc: sample.timestampUtc,
        updatedAtUtc: sample.timestampUtc,
        value: candidate.value,
      };
      next.active[code] = warning;
      changes.push({ transition: "open", warning });
      counter.violatingSamples = 0;
    } else if (active && active.severity !== candidate.severity && counter.violatingSamples >= CONFIG.warningOpenSamples) {
      const warning = { ...active, severity: candidate.severity, message: candidate.message, updatedAtUtc: sample.timestampUtc, value: candidate.value };
      next.active[code] = warning;
      changes.push({ transition: "severity-change", warning });
      counter.violatingSamples = 0;
    } else if (active) {
      next.active[code] = { ...active, message: candidate.message, updatedAtUtc: sample.timestampUtc, value: candidate.value };
    }
    next.counters[code] = counter;
  }
  return { state: next, changes };
}
