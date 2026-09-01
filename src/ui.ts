import { defineWidget, rgb, ui, type LogEntry, type Rgb24, type TableColumn, type VNode } from "@rezi-ui/core";
import { createNodeApp } from "@rezi-ui/node";
import type {
  ProcessRankings,
  RankedProcess,
  RankingDimension,
  Sample,
  WarningState,
} from "./model.ts";

export interface DashboardEvent {
  id: string;
  timestampUtc: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
}

export interface DashboardSnapshot {
  sessionId: string;
  latest: Sample | null;
  history: readonly Sample[];
  historyStatus: {
    requestedWindowMs: number;
    loadedWindowMs: number;
    loading: boolean;
    error: string | null;
  };
  rankings: ProcessRankings | null;
  warnings: WarningState;
  events: readonly DashboardEvent[];
  checkpointTimestampUtc: string | null;
}

export interface DashboardController {
  signal: AbortSignal;
  getSnapshot(): DashboardSnapshot;
  subscribe(listener: (snapshot: DashboardSnapshot) => void): () => void;
  requestHistory(windowMs: number): void;
  restartGraphicsStack(): Promise<void>;
  killProcess(identity: string): Promise<void>;
  shutdown(reason: string): Promise<void>;
}

export interface DashboardState {
  snapshot: DashboardSnapshot;
  view: 1 | 2 | 3;
  graphWindowMs: number;
  ranking: RankingDimension;
  frozen: boolean;
  chartEndMs: number | null;
  eventScrollTop: number;
  graphicsResetOpen: boolean;
  selectedProcessIdentity: string | null;
  killTarget: { identity: string; pid: number; name: string } | null;
  killHelpOpen: boolean;
  stoppingProcessIdentity: string | null;
}

export const GRAPH_WINDOWS = [300_000, 1_800_000, 7_200_000, 18_000_000] as const;
const RANKINGS: readonly RankingDimension[] = ["privateCommit", "privateWorkingSet", "workingSet", "cpu", "io", "gpuCommitted", "gpuResident", "wddmRaw", "growth"];

interface LineSeries {
  color: string;
  label: string;
  value(sample: Sample): number | null;
  formatValue(value: number): string;
}

export interface PlotBucket {
  min: number;
  max: number;
  last: number;
  segment: number;
}

export function buildPlotBuckets(
  samples: readonly Sample[],
  valueOf: (sample: Sample) => number | null,
  startMs: number,
  windowMs: number,
  width: number,
): PlotBucket[][] {
  const buckets: PlotBucket[][] = Array.from({ length: width }, () => []);
  let segment = 0;
  let previousTimestamp: number | null = null;
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestampUtc);
    if (timestamp < startMs || timestamp > startMs + windowMs) continue;
    if (previousTimestamp !== null && timestamp - previousTimestamp > 5_000) segment++;
    previousTimestamp = timestamp;
    const value = valueOf(sample);
    if (value === null || !Number.isFinite(value)) {
      segment++;
      continue;
    }
    const x = Math.max(0, Math.min(width - 1, Math.floor((timestamp - startMs) / windowMs * (width - 1))));
    const column = buckets[x]!;
    const bucket = column.at(-1);
    if (bucket?.segment === segment) {
      bucket.min = Math.min(bucket.min, value);
      bucket.max = Math.max(bucket.max, value);
      bucket.last = value;
    } else {
      column.push({ min: value, max: value, last: value, segment });
    }
  }
  return buckets;
}

const GB = 1024 ** 3;
const COLORS = {
  border: "#64748b",
  grid: "#475569",
  label: "#cbd5e1",
  whisker: "#94a3b8",
  ram: "#facc15",
  commit: "#fb7185",
  vramPressure: "#60a5fa",
  pagesIn: "#c084fc",
  pageReads: "#2dd4bf",
  paged: "#f59e0b",
  nonpaged: "#f87171",
  wddm: "#38bdf8",
  gpuCommitted: "#facc15",
  gpuResident: "#a78bfa",
  dwm: "#f472b6",
  vramUsed: "#4ade80",
} as const;

const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });


function terminalColor(hex: string): Rgb24 {
  const value = Number.parseInt(hex.slice(1), 16);
  return rgb(value >> 16, value >> 8 & 0xff, value & 0xff);
}

function chartPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function chartGigabytes(value: number): string {
  return `${value.toFixed(2)}G`;
}

function chartRate(value: number): string {
  return `${Math.round(value)}/s`;
}

function neutralCard(title: string, children: readonly VNode[]): VNode {
  return ui.box({
    border: "single",
    borderStyle: { fg: terminalColor(COLORS.border) },
    p: 0,
    height: "full",
  }, [
    ui.column({ gap: 0, height: "full" }, [
      ui.text(` ${title}`, { variant: "label" }),
      ui.box({ border: "none", flex: 1, minHeight: 4, overflow: "hidden" }, children),
    ]),
  ]);
}

function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 3 ? 3 : normalized <= 5 ? 5 : 10) * magnitude;
}

function axisLabel(value: number): string {
  if (value >= 1_000) return value.toFixed(0);
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1);
}

function areaColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = Math.round((value >> 16 & 0xff) * 0.28).toString(16).padStart(2, "0");
  const green = Math.round((value >> 8 & 0xff) * 0.28).toString(16).padStart(2, "0");
  const blue = Math.round((value & 0xff) * 0.28).toString(16).padStart(2, "0");
  return `#${red}${green}${blue}`;
}

export function lineChart(
  series: readonly LineSeries[],
  samples: readonly Sample[],
  windowMs: number,
  endMs: number,
  minimumCeiling: number,
  fixedCeiling = false,
  compactTitle: string | null = null,
  area = false,
): VNode {
  const startMs = endMs - windowMs;
  let observedMaximum = 0;
  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestampUtc);
    if (timestamp < startMs || timestamp > endMs) continue;
    for (const entry of series) {
      const value = entry.value(sample);
      if (value !== null && Number.isFinite(value)) observedMaximum = Math.max(observedMaximum, value);
    }
  }
  const ceiling = fixedCeiling ? minimumCeiling : niceCeiling(Math.max(minimumCeiling, observedMaximum * 1.2));
  const areaColors = area ? series.map((entry) => areaColor(entry.color)) : [];

  return ui.canvas({
    width: "full",
    height: "full",
    blitter: "braille",
    draw: (canvas) => {
      const footerHeight = 8;
      const plotHeight = Math.max(1, canvas.height - footerHeight);
      const leftWidth = compactTitle ? 0 : 12;
      const rightWidth = compactTitle ? 0 : Math.max(16, ...series.map((entry) => entry.formatValue(ceiling).length * 2 + 2));
      const plotWidth = Math.max(2, canvas.width - leftWidth - rightWidth);
      const plotRight = leftWidth + plotWidth - 1;
      const yPosition = (value: number): number =>
        Math.max(0, Math.min(plotHeight - 1, (plotHeight - 1) * (1 - value / ceiling)));
      const seriesBuckets = series.map((entry) => buildPlotBuckets(samples, entry.value, startMs, windowMs, plotWidth));
      if (area) {
        for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
          const fillColor = areaColors[seriesIndex]!;
          let previous: { x: number; bucket: PlotBucket } | null = null;
          for (let x = 0; x < seriesBuckets[seriesIndex]!.length; x++) {
            for (const bucket of seriesBuckets[seriesIndex]![x]!) {
              if (previous && previous.bucket.segment === bucket.segment) {
                const distance = x - previous.x;
                for (let offset = 0; offset <= distance; offset++) {
                  const value = distance === 0
                    ? bucket.last
                    : previous.bucket.last + (bucket.last - previous.bucket.last) * offset / distance;
                  canvas.line(leftWidth + previous.x + offset, yPosition(value), leftWidth + previous.x + offset, plotHeight - 1, fillColor);
                }
              }
              canvas.line(leftWidth + x, yPosition(bucket.max), leftWidth + x, plotHeight - 1, fillColor);
              previous = { x, bucket };
            }
          }
        }
      }


      for (const guide of [0, 0.5, 1]) {
        const value = ceiling * (1 - guide);
        const y = Math.round((plotHeight - 1) * guide);
        canvas.line(leftWidth, y, plotRight, y, COLORS.grid);
        if (!compactTitle) canvas.text(0, y, axisLabel(value).padStart(5), COLORS.label);
      }

      const occupiedLabelRows: number[] = [];
      for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
        const entry = series[seriesIndex]!;
        const buckets = seriesBuckets[seriesIndex]!;

        let previous: { x: number; bucket: PlotBucket } | null = null;
        let endpoint: number | null = null;
        for (let x = 0; x < buckets.length; x++) {
          for (const bucket of buckets[x]!) {
            const plotX = leftWidth + x;
            canvas.line(plotX, yPosition(bucket.max), plotX, yPosition(bucket.min), entry.color);
            if (previous && previous.bucket.segment === bucket.segment) {
              canvas.line(
                leftWidth + previous.x,
                yPosition(previous.bucket.last),
                plotX,
                yPosition(bucket.last),
                entry.color,
              );
            }
            previous = { x, bucket };
            endpoint = bucket.last;
          }
        }
        if (endpoint !== null && !compactTitle) {
          const maximumRow = Math.max(0, Math.floor((plotHeight - 1) / 4));
          let labelRow = Math.max(0, Math.min(maximumRow, Math.round(yPosition(endpoint) / 4)));
          while (occupiedLabelRows.includes(labelRow) && labelRow < maximumRow) labelRow++;
          while (occupiedLabelRows.includes(labelRow) && labelRow > 0) labelRow--;
          occupiedLabelRows.push(labelRow);
          canvas.text(plotRight + 2, labelRow * 4, entry.formatValue(endpoint), entry.color);
        }
      }

      if (compactTitle) {
        canvas.text(0, plotHeight, compactTitle, COLORS.label);
      } else {
        let legendX = leftWidth;
        for (const entry of series) {
          canvas.text(legendX, plotHeight, entry.label, entry.color);
          legendX += (entry.label.length + 2) * 2;
        }
      }
      const ticks = [startMs, startMs + windowMs / 2, endMs];
      for (let index = 0; index < ticks.length; index++) {
        const label = CLOCK_FORMAT.format(new Date(ticks[index]!));
        const x = index === 0
          ? leftWidth
          : index === 1
            ? leftWidth + Math.floor((plotWidth - label.length * 2) / 2)
            : plotRight - label.length * 2 + 1;
        canvas.text(x, plotHeight + 4, label, COLORS.label);
      }
    },
  });
}

function bytes(value: number | null): string {
  if (value === null) return "n/a";
  if (Math.abs(value) >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (Math.abs(value) >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function ratio(value: number | null, total: number | null): number | null {
  return value === null || total === null || total <= 0 ? null : value / total;
}


export function adapterTotal(sample: Sample, field: "usedVramBytes" | "totalVramBytes"): number | null {
  if (!sample.nvidia.length) return null;
  let total = 0;
  for (const adapter of sample.nvidia) {
    const value = adapter[field];
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function worstAdapterPercent(sample: Sample): number | null {
  if (!sample.nvidia.length) return null;
  let worst = 0;
  for (const adapter of sample.nvidia) {
    const value = ratio(adapter.usedVramBytes, adapter.totalVramBytes);
    if (value === null) return null;
    worst = Math.max(worst, value);
  }
  return worst * 100;
}

function chartEnd(state: DashboardState): number {
  return state.frozen && state.chartEndMs !== null ? state.chartEndMs : Date.now();
}

function chartHistory(state: DashboardState): readonly Sample[] {
  const end = chartEnd(state);
  const start = end - state.graphWindowMs;
  const history = state.snapshot.history.filter((sample) => {
    const timestamp = Date.parse(sample.timestampUtc);
    return timestamp >= start && timestamp <= end;
  });
  const latest = state.snapshot.latest;
  if (!latest) return history;
  const latestTimestamp = Date.parse(latest.timestampUtc);
  if (latestTimestamp < start || latestTimestamp > end || history.some((sample) => sample.timestampUtc === latest.timestampUtc)) {
    return history;
  }
  return [...history, latest];
}

function duration(valueMs: number): string {
  const seconds = Math.round(valueMs / 1_000);
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

export function historyCoverage(samples: readonly Sample[], endMs: number): { spanMs: number; gapsMs: number } {
  const ordered = [...samples].sort((left, right) => Date.parse(left.timestampUtc) - Date.parse(right.timestampUtc));
  const first = ordered[0];
  const last = ordered.at(-1);
  const spanMs = first && last ? Date.parse(last.timestampUtc) - Date.parse(first.timestampUtc) : 0;
  let gapsMs = 0;
  for (let index = 1; index < ordered.length; index++) {
    const gap = Date.parse(ordered[index]!.timestampUtc) - Date.parse(ordered[index - 1]!.timestampUtc);
    if (gap > 5_000) gapsMs += Math.max(0, gap - ordered[index - 1]!.intervalMs);
  }
  if (last) {
    const endGap = endMs - Date.parse(last.timestampUtc);
    if (endGap > 5_000) gapsMs += Math.max(0, endGap - last.intervalMs);
  }
  return { spanMs, gapsMs };
}

function coverageCue(state: DashboardState, samples: readonly Sample[]): VNode {
  const coverage = historyCoverage(samples, chartEnd(state));
  const status = state.snapshot.historyStatus;
  const visibleHistoryMissing = status.loadedWindowMs < state.graphWindowMs;
  const details = [
    `Span ${duration(coverage.spanMs)} / ${duration(state.graphWindowMs)}`,
    ...(coverage.gapsMs > 0 ? [`gaps ${duration(coverage.gapsMs)}`] : []),
    ...(status.loading && visibleHistoryMissing ? ["loading history"] : []),
    ...(status.error && visibleHistoryMissing ? ["history unavailable"] : []),
  ];
  return ui.text(details.join(" · "), { variant: "caption" });
}

function warningValue(code: string, value: number | null): string {
  if (value === null) return "n/a";
  if (code === "ram" || code === "commit" || code === "nvidia-vram") return percent(value);
  if (code === "active-paging") return `${Math.round(value)}/s`;
  if (code === "display-device") return String(Math.round(value));
  return bytes(value);
}

function warningBanner(state: DashboardState, bordered: boolean, coverage: VNode): VNode | null {
  const active = Object.values(state.snapshot.warnings.active)
    .flatMap((warning) => warning ? [warning] : [])
    .sort((left, right) => (left.severity === right.severity ? left.code.localeCompare(right.code) : left.severity === "critical" ? -1 : 1));
  if (!active.length) return null;
  const content = ui.row({ gap: 1, wrap: true }, [
    ui.text("Warnings", { variant: "label" }),
    ...active.map((warning) => ui.badge(`${warning.code} ${warningValue(warning.code, warning.value)}`, {
      variant: warning.severity === "critical" ? "error" : "warning",
    })),
    coverage,
  ]);
  return bordered
    ? ui.box({
      border: "single",
      borderStyle: { fg: terminalColor(COLORS.border) },
      px: 1,
    }, [content])
    : content;
}

function metricGauge(label: string, value: number | null, warning: number, critical: number): VNode {
  return value === null
    ? ui.text(`${label} n/a`, { variant: "label" })
    : ui.gauge(Math.max(0, Math.min(1, value)), {
      label,
      thresholds: [{ value: warning, variant: "warning" }, { value: critical, variant: "error" }],
    });
}

function healthStrip(sample: Sample | null, wide: boolean, bordered: boolean, flex?: number): VNode {
  const frame = (content: VNode): VNode => bordered
    ? ui.box({
      border: "single",
      borderStyle: { fg: terminalColor(COLORS.border) },
      px: 1,
      ...(flex === undefined ? {} : { flex }),
    }, [content])
    : content;
  if (!sample) return frame(ui.text("Waiting for live telemetry", { variant: "caption" }));
  const system = sample.system;
  const commit = ratio(system.committedBytes, system.commitLimitBytes);
  const vram = worstAdapterPercent(sample);
  const paging = `Paging ${system.pageInputsPerSecond === null ? "n/a" : `${Math.round(system.pageInputsPerSecond)} pages-in/s`} · ${system.pageReadsPerSecond === null ? "n/a" : `${Math.round(system.pageReadsPerSecond)} read ops/s`}`;
  const gauges = ui.row({ gap: 1 }, [
    metricGauge("RAM", system.usedPhysicalPercent === null ? null : system.usedPhysicalPercent / 100, 0.9, 0.95),
    metricGauge("Commit", commit, 0.8, 0.9),
    metricGauge("VRAM", vram === null ? null : vram / 100, 0.9, 0.97),
  ]);
  return frame(ui.column({ gap: 0 }, wide
    ? [
      gauges,
      ui.row({ gap: 1, wrap: true }, [
        ui.text(`Available RAM ${bytes(system.availablePhysicalBytes)}`),
        ui.text(`Commit headroom ${bytes(system.committedBytes === null || system.commitLimitBytes === null ? null : system.commitLimitBytes - system.committedBytes)}`),
        ui.text(`Pagefile ${bytes(system.pagefileCurrentBytes)} / ${bytes(system.pagefileAllocatedBytes)}`),
        ui.text(paging),
      ]),
    ]
    : [gauges, ui.text(paging, { variant: "caption" })]));
}

function attribution(state: DashboardState, dimension: "private" | "gpuResident"): readonly string[] {
  const latest = state.snapshot.latest;
  const failed = latest
    ? [latest.sources.process, ...(dimension === "gpuResident" ? [latest.sources.wddm] : [])]
      .filter((source) => source && source.state !== "ok")
    : [];
  if (failed.length) {
    return [`Attribution ${state.snapshot.rankings ? "stale" : "unavailable"}: ${failed.map((source) => source!.state).join(", ")}`];
  }
  const rankings = state.snapshot.rankings;
  if (!rankings) return ["Collecting process inventory"];
  const groups = [...rankings.byExecutable]
    .sort((left, right) => dimension === "private"
      ? right.privateBytes - left.privateBytes
      : right.gpuResidentBytes - left.gpuResidentBytes)
    .filter((group) => (dimension === "private" ? group.privateBytes : group.gpuResidentBytes) > 0)
    .slice(0, 3);
  if (!groups.length) return ["No attributed allocations"];
  return groups.map((group) => `${group.name} (${group.count})  ${bytes(dimension === "private" ? group.privateBytes : group.gpuResidentBytes)}`);
}

function offenderCard(title: string, rows: readonly string[]): VNode {
  return ui.box({
    border: "single",
    borderStyle: { fg: terminalColor(COLORS.border) },
    px: 1,
    flex: 2,
  }, [
    ui.column({ gap: 0 }, [
      ui.text(title, { variant: "label" }),
      ...rows.map((row) => ui.text(row)),
    ]),
  ]);
}

export function renderOverview(state: DashboardState, viewport: Readonly<{ width: number; height: number }>): VNode {
  const sample = state.snapshot.latest;
  const history = chartHistory(state);
  const end = chartEnd(state);
  const kernelMinimum = 2;
  const gpuMinimum = 8;
  const charts = [
    {
      title: "Pressure %",
      ceiling: 100,
      fixed: true,
      area: true,
      series: [
        { label: "RAM used", color: COLORS.ram, value: (item: Sample) => item.system.usedPhysicalPercent, formatValue: chartPercent },
        { label: "commit", color: COLORS.commit, value: (item: Sample) => {
          const value = ratio(item.system.committedBytes, item.system.commitLimitBytes);
          return value === null ? null : value * 100;
        }, formatValue: chartPercent },
        { label: "VRAM worst", color: COLORS.vramPressure, value: worstAdapterPercent, formatValue: chartPercent },
      ],
    },
    {
      title: "Paging",
      ceiling: 1,
      fixed: false,
      area: false,
      series: [
        { label: "pages-in/s", color: COLORS.pagesIn, value: (item: Sample) => item.system.pageInputsPerSecond, formatValue: chartRate },
        { label: "read ops/s", color: COLORS.pageReads, value: (item: Sample) => item.system.pageReadsPerSecond, formatValue: chartRate },
      ],
    },
    {
      title: "Kernel pools GB · ref 8",
      ceiling: kernelMinimum,
      fixed: false,
      area: true,
      series: [
        { label: "paged", color: COLORS.paged, value: (item: Sample) => item.system.pagedPoolAllocatedBytes === null ? null : item.system.pagedPoolAllocatedBytes / GB, formatValue: chartGigabytes },
        { label: "nonpaged", color: COLORS.nonpaged, value: (item: Sample) => item.system.nonpagedPoolBytes === null ? null : item.system.nonpagedPoolBytes / GB, formatValue: chartGigabytes },
      ],
    },
    {
      title: "GPU memory GB · ref 16",
      ceiling: gpuMinimum,
      fixed: false,
      area: true,
      series: [
        { label: "commit", color: COLORS.gpuCommitted, value: (item: Sample) => item.system.gpuCommittedBytes == null ? null : item.system.gpuCommittedBytes / GB, formatValue: chartGigabytes },
        { label: "resident", color: COLORS.gpuResident, value: (item: Sample) => item.system.gpuResidentBytes == null ? null : item.system.gpuResidentBytes / GB, formatValue: chartGigabytes },
        { label: "VRAM", color: COLORS.vramUsed, value: (item: Sample) => {
          const value = adapterTotal(item, "usedVramBytes");
          return value === null ? null : value / GB;
        }, formatValue: chartGigabytes },
      ],
    },
    {
      title: "WDDM raw GB · ref 16",
      ceiling: gpuMinimum,
      fixed: false,
      area: true,
      series: [
        { label: "system raw", color: COLORS.wddm, value: (item: Sample) => {
          const value = item.system.wddmRawBytes;
          return value === null ? null : value / GB;
        }, formatValue: chartGigabytes },
        { label: "DWM raw", color: COLORS.dwm, value: (item: Sample) => item.system.dwmWddmRawBytes === null ? null : item.system.dwmWddmRawBytes / GB, formatValue: chartGigabytes },
      ],
    },
  ] satisfies readonly { title: string; ceiling: number; fixed: boolean; area: boolean; series: readonly LineSeries[] }[];
  const renderChart = (chart: typeof charts[number]): VNode =>
    ui.box({ border: "none", flex: 1, height: "full" }, [
      neutralCard(chart.title, [lineChart(chart.series, history, state.graphWindowMs, end, chart.ceiling, chart.fixed, null, chart.area)]),
    ]);
  const renderCompactChart = (chart: typeof charts[number]): VNode =>
    ui.box({ border: "none", flex: 1, minHeight: 3 }, [
      lineChart(chart.series, history, state.graphWindowMs, end, chart.ceiling, chart.fixed, chart.title, chart.area),
    ]);
  const coverage = coverageCue(state, history);
  const warning = warningBanner(state, viewport.height >= 30, coverage);
  const showDiagnosticRail = viewport.width >= 160 && viewport.height >= 30;
  const diagnosticRail = ui.row({ gap: 1, minHeight: 6 }, [
    healthStrip(sample, true, true, 3),
    offenderCard("Top private commit", attribution(state, "private")),
    offenderCard("Top GPU resident", attribution(state, "gpuResident")),
  ]);

  const chartLayout = viewport.height < 30
    ? ui.column({ gap: 0, flex: 1, minHeight: 6 }, [
      ui.row({ gap: 1, flex: 1, minHeight: 3 }, charts.slice(0, 2).map(renderCompactChart)),
      ui.row({ gap: 1, flex: 1, minHeight: 3 }, charts.slice(2).map(renderCompactChart)),
    ])
    : viewport.width >= 190
      ? ui.row({ gap: 1, flex: 1, minHeight: 8 }, charts.map(renderChart))
      : ui.column({ gap: 1, flex: 1, minHeight: 12 }, [
        ui.row({ gap: 1, flex: 1, minHeight: 5 }, charts.slice(0, 2).map(renderChart)),
        ui.row({ gap: 1, flex: 1, minHeight: 5 }, charts.slice(2).map(renderChart)),
      ]);

  return ui.column({ gap: 0, height: "full" }, [
    warning ?? coverage,
    showDiagnosticRail ? diagnosticRail : healthStrip(sample, viewport.width >= 120, viewport.height >= 30),
    chartLayout,
    ...(!showDiagnosticRail && viewport.height >= 34
      ? [ui.box({
        border: "single",
        borderStyle: { fg: terminalColor(COLORS.border) },
        px: 1,
      }, [
        ui.row({ gap: 2, wrap: true }, [
          ui.text(`Top private commit: ${attribution(state, "private").join(" · ")}`),
          ui.text(`Top GPU resident: ${attribution(state, "gpuResident").join(" · ")}`),
        ]),
      ])]
      : []),
  ]);
}
export const overview = defineWidget<DashboardState & { key?: string }>((state, ctx) => renderOverview(state, ctx.useViewport()));

function rightCell(content: string, width: number): VNode {
  return ui.text(content.padStart(width));
}


function processColumns(stoppingProcessIdentity: string | null): readonly TableColumn<RankedProcess>[] {
  return [
    {
      key: "name",
      header: "Process",
      flex: 1,
      render: (_, row) => ui.row({ gap: 1 }, [
        ui.text(`${row.self ? "[self] " : ""}${row.name}`),
        ...(row.identity === stoppingProcessIdentity ? [ui.text("(stopping…)", { style: { dim: true } })] : []),
      ]),
    },
    { key: "pid", header: "PID", width: 8, align: "right" },
    { key: "privateBytes", header: "Private", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.privateBytes), 11) },
    { key: "privateWorkingSetBytes", header: "Private WS", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.privateWorkingSetBytes), 11) },
    { key: "workingSetBytes", header: "WS", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.workingSetBytes), 11) },
    { key: "cpuHostPercent", header: "CPU", width: 8, align: "right", render: (_, row) => rightCell(percent(row.cpuHostPercent), 8) },
    { key: "ioBytesPerSecond", header: "I/O", width: 10, align: "right", render: (_, row) => rightCell(`${bytes(row.ioBytesPerSecond)}/s`, 10) },
    { key: "gpuCommittedBytes", header: "GPU commit", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.gpuCommittedBytes), 11) },
    { key: "gpuResidentBytes", header: "GPU resident", width: 12, align: "right", render: (_, row) => rightCell(bytes(row.gpuResidentBytes), 12) },
    { key: "wddmRawBytes", header: "WDDM raw", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.wddmRawBytes), 11) },
    { key: "growth60SecondsBytes", header: "Growth", width: 10, align: "right", render: (_, row) => rightCell(bytes(row.growth60SecondsBytes), 10) },
  ];
}

function selectedRanking(rankings: ProcessRankings, dimension: RankingDimension): readonly RankedProcess[] {
  switch (dimension) {
    case "privateCommit": return rankings.topPrivateCommit;
    case "privateWorkingSet": return rankings.topPrivateWorkingSet;
    case "workingSet": return rankings.topWorkingSet;
    case "cpu": return rankings.topCpu;
    case "io": return rankings.topIo;
    case "gpuCommitted": return rankings.topGpuCommitted;
    case "gpuResident": return rankings.topGpuResident;
    case "wddmRaw": return rankings.topWddmRaw;
    case "growth": return rankings.topGrowth;
  }
}

function activeProcess(rows: readonly RankedProcess[], identity: string | null): RankedProcess | null {
  return (identity ? rows.find((row) => row.identity === identity) : undefined)
    ?? rows.find((row) => !row.self && row.creationUtc)
    ?? rows[0]
    ?? null;
}

export function moveProcessCursor(state: DashboardState, direction: -1 | 1): DashboardState {
  if (state.view !== 2 || !state.snapshot.rankings) return state;
  const rows = selectedRanking(state.snapshot.rankings, state.ranking);
  if (!rows.length) return state;
  const current = activeProcess(rows, state.selectedProcessIdentity);
  const index = Math.max(0, current ? rows.indexOf(current) : 0);
  const target = rows[Math.max(0, Math.min(rows.length - 1, index + direction))]!;
  return { ...state, selectedProcessIdentity: target.identity };
}

export function processKillTarget(state: DashboardState): RankedProcess | null {
  if (state.view !== 2 || !state.snapshot.rankings) return null;
  const target = activeProcess(selectedRanking(state.snapshot.rankings, state.ranking), state.selectedProcessIdentity);
  return target && !target.self && target.creationUtc ? target : null;
}

export function openProcessKill(state: DashboardState): DashboardState {
  const target = processKillTarget(state);
  return target
    ? { ...state, selectedProcessIdentity: target.identity, killTarget: { identity: target.identity, pid: target.pid, name: target.name }, killHelpOpen: false }
    : { ...state, killHelpOpen: true };
}

function processes(props: {
  rankings: ProcessRankings | null;
  ranking: RankingDimension;
  selectedProcessIdentity: string | null;
  stoppingProcessIdentity: string | null;
  onSelection(process: string): void;
}): VNode {
  if (!props.rankings) return ui.empty("Waiting for process inventory");
  const rows = selectedRanking(props.rankings, props.ranking);
  const selectedProcess = activeProcess(rows, props.selectedProcessIdentity);
  const selection = selectedProcess
    ? `Target: ${selectedProcess.name} (PID ${selectedProcess.pid}) — k to stop`
    : "No process available";
  return ui.column({ gap: 1, height: "full" }, [
    ui.text(`Ranking: ${props.ranking} | ${selection}`),
    ui.table({
      id: "process-rows",
      key: `rows-${props.ranking}`,
      accessibleLabel: "Processes",
      columns: processColumns(props.stoppingProcessIdentity),
      data: rows,
      getRowKey: (row) => row.identity,
      selection: selectedProcess ? [selectedProcess.identity] : [],
      selectionMode: "single",
      selectionStyle: { inverse: true },
      focusConfig: { indicator: "none", contentStyle: {} },
      onRowPress: (row) => props.onSelection(row.identity),
      border: "single",
      flex: 1,
      minHeight: 5,
    }),
  ]);
}

function events(state: DashboardState, onScroll: (scrollTop: number) => void): VNode {
  const entries: LogEntry[] = state.snapshot.events.map((event) => ({
    id: event.id,
    timestamp: Date.parse(event.timestampUtc),
    level: event.level,
    source: event.source,
    message: event.message,
  })).reverse();
  return ui.logsConsole({
    id: "events",
    focusable: false,
    focusConfig: { indicator: "none", contentStyle: {} },
    entries,
    autoScroll: false,
    scrollTop: state.eventScrollTop,
    onScroll,
    showTimestamps: true,
    showSource: true,
    height: "full",
  });
}

function footerLegend(state: DashboardState): string {
  const freeze = `Space ${state.frozen ? "Resume" : "Freeze"}`;
  if (state.view === 1) {
    const minutes = state.graphWindowMs / 60_000;
    const window = minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
    return `W Window (${window})  ${freeze}  g DWM restart  q Quit`;
  }
  if (state.view === 2) return `Tab Process  ↑↓ Target  k Stop  r Rank  ${freeze}  q Quit`;
  return `${freeze}  q Quit`;
}

export function renderDashboard(
  state: DashboardState,
  onGraphicsResetConfirm: () => void,
  onGraphicsResetCancel: () => void,
  onKillConfirm: (identity: string) => void,
  onKillCancel: () => void,
  onProcessSelection: (process: string) => void,
  onEventsScroll: (scrollTop: number) => void = () => undefined,
): VNode {
  const latest = state.snapshot.latest;
  const windowMinutes = state.graphWindowMs / 60_000;
  const degraded = latest
    ? Object.entries(latest.sources).filter(([, health]) => health.state !== "ok").map(([name]) => name)
    : [];
  const body = state.view === 1 ? overview(state) : state.view === 2
    ? processes({
      rankings: state.snapshot.rankings,
      ranking: state.ranking,
      selectedProcessIdentity: state.selectedProcessIdentity,
      stoppingProcessIdentity: state.stoppingProcessIdentity,
      onSelection: onProcessSelection,
    })
    : events(state, onEventsScroll);
  const graphicsResetDialog = state.graphicsResetOpen
    ? ui.dialog({
      id: "graphics-reset-confirm",
      title: "Restart Desktop Window Manager",
      message: ui.column({ gap: 1 }, [
        ui.callout("Displays will flicker and Windows will redraw the desktop.", {
          variant: "warning",
          title: "Reset DWM graphics allocations",
        }),
        ui.text("Windows will request administrator permission."),
        ui.text("Open applications stay running."),
      ]),
      actions: [
        { id: "graphics-reset-cancel", label: "Cancel", onPress: onGraphicsResetCancel },
        { id: "graphics-reset-confirm-action", label: "Restart DWM", intent: "danger", onPress: onGraphicsResetConfirm },
      ],
      width: 66,
      height: 14,
      maxWidth: "full",
      backdrop: "dim",
      initialFocus: "graphics-reset-cancel",
      onClose: onGraphicsResetCancel,
    })
    : null;
  const killDialog = state.killTarget
    ? ui.dialog({
      id: "process-kill-confirm",
      title: "Kill process",
      message: ui.column({ gap: 1 }, [
        ui.callout(`${state.killTarget.name} (PID ${state.killTarget.pid}) will be force-stopped.`, {
          variant: "warning",
          title: "Unsaved work may be lost",
        }),
        ui.text("The process identity will be verified again before termination."),
      ]),
      actions: [
        { id: "process-kill-confirm-action", label: "OK", intent: "danger", onPress: () => onKillConfirm(state.killTarget!.identity) },
        { id: "process-kill-cancel", label: "Cancel", onPress: onKillCancel },
      ],
      width: 66,
      height: 13,
      maxWidth: "full",
      backdrop: "dim",
      initialFocus: "process-kill-confirm-action",
      onClose: onKillCancel,
    })
    : null;
  const killHelpDialog = state.killHelpOpen
    ? ui.dialog({
      id: "process-kill-help",
      title: "Process cannot be stopped",
      message: ui.text("This row is ram-probe or does not have a stable process identity. Choose another process."),
      actions: [
        { id: "process-kill-help-ok", label: "OK", onPress: onKillCancel },
      ],
      width: 72,
      height: 10,
      maxWidth: "full",
      backdrop: "dim",
      initialFocus: "process-kill-help-ok",
      onClose: onKillCancel,
    })
    : null;
  const dashboard = ui.column({ p: 1, gap: 0, height: "full" }, [
    ui.header({
      title: "ram-probe",
      subtitle: `${latest?.timestampUtc ?? "waiting"} | ${windowMinutes >= 60 ? `${windowMinutes / 60}h` : `${windowMinutes}m`} | ${state.frozen ? "FROZEN" : "live"}${degraded.length ? ` | degraded: ${degraded.join(",")}` : ""}`,
      actions: [
        ui.text("1 Overview", { variant: "caption", style: state.view === 1 ? { fg: rgb(255, 255, 255), bold: true } : { dim: true } }),
        ui.text("2 Processes", { variant: "caption", style: state.view === 2 ? { fg: rgb(255, 255, 255), bold: true } : { dim: true } }),
        ui.text("3 Events", { variant: "caption", style: state.view === 3 ? { fg: rgb(255, 255, 255), bold: true } : { dim: true } }),
      ],
    }),
    ui.box({ border: "none", flex: 1, minHeight: 1, overflow: "hidden" }, [body]),
    ui.statusBar({
      left: [ui.text(footerLegend(state))],
      right: [ui.text(`session ${state.snapshot.sessionId.slice(0, 8)}`)],
    }),
  ]);
  const overlays = [graphicsResetDialog, killDialog, killHelpDialog].flatMap((layer) => layer ? [layer] : []);
  return overlays.length ? ui.layers([dashboard, ...overlays]) : dashboard;
}

export async function createDashboard(controller: DashboardController): Promise<void> {
  const initialState: DashboardState = {
    snapshot: controller.getSnapshot(),
    view: 1,
    graphWindowMs: GRAPH_WINDOWS[0],
    ranking: RANKINGS[0]!,
    frozen: false,
    chartEndMs: null,
    eventScrollTop: 0,
    graphicsResetOpen: false,
    selectedProcessIdentity: null,
    killTarget: null,
    killHelpOpen: false,
    stoppingProcessIdentity: null,
  };
  const app = createNodeApp({ initialState, config: { fpsCap: 20, rootPadding: 0 } });
  const closeGraphicsReset = (): void => app.update((state) => ({ ...state, graphicsResetOpen: false }));
  const closeKill = (): void => app.update((state) => ({ ...state, killTarget: null, killHelpOpen: false }));
  app.view((state) => renderDashboard(
    state,
    () => {
      closeGraphicsReset();
      void controller.restartGraphicsStack();
    },
    closeGraphicsReset,
    (identity) => {
      app.update((state) => ({
        ...state,
        killTarget: null,
        killHelpOpen: false,
        stoppingProcessIdentity: identity,
      }));
      void controller.killProcess(identity).finally(() => {
        if (!controller.signal.aborted) {
          app.update((state) => state.stoppingProcessIdentity === identity
            ? { ...state, stoppingProcessIdentity: null }
            : state);
        }
      });
    },
    closeKill,
    (process) => app.update((state) => ({ ...state, selectedProcessIdentity: process })),
    (scrollTop) => app.update((state) => ({ ...state, eventScrollTop: scrollTop })),
  ));
  const quit = (reason: string): void => {
    void controller.shutdown(reason);
  };
  app.keys({
    "1": ({ update }) => update((state) => ({ ...state, view: 1 })),
    "2": ({ update }) => update((state) => ({ ...state, view: 2 })),
    "3": ({ update }) => update((state) => ({ ...state, view: 3, eventScrollTop: 0 })),
    g: ({ update }) => update((state) => ({ ...state, graphicsResetOpen: true })),
    w: {
      when: ({ state }) => state.view === 1,
      handler: ({ update, state }) => {
        const index = GRAPH_WINDOWS.indexOf(state.graphWindowMs as typeof GRAPH_WINDOWS[number]);
        const graphWindowMs = GRAPH_WINDOWS[(index + 1) % GRAPH_WINDOWS.length]!;
        controller.requestHistory(graphWindowMs);
        update((current) => ({ ...current, graphWindowMs }));
      },
    },
    r: {
      when: ({ state }) => state.view === 2,
      handler: ({ update, state }) => {
        const index = RANKINGS.indexOf(state.ranking);
        update({
          ...state,
          ranking: RANKINGS[(index + 1) % RANKINGS.length]!,
          selectedProcessIdentity: null,
        });
      },
    },
    up: {
      when: ({ state, focusedId }) => state.view === 2 && focusedId === "process-rows",
      handler: ({ update, state }) => update(moveProcessCursor(state, -1)),
    },
    down: {
      when: ({ state, focusedId }) => state.view === 2 && focusedId === "process-rows",
      handler: ({ update, state }) => update(moveProcessCursor(state, 1)),
    },
    enter: {
      when: ({ state, focusedId }) => state.view === 2 && focusedId === "process-rows",
      handler: () => undefined,
    },
    k: {
      when: ({ state, focusedId }) => state.view === 2 && focusedId === "process-rows",
      handler: ({ update, state }) => update(openProcessKill(state)),
    },
    space: ({ update }) => update((state) => {
      const frozen = !state.frozen;
      return {
        ...state,
        frozen,
        chartEndMs: frozen ? Date.now() : null,
        snapshot: frozen ? state.snapshot : controller.getSnapshot(),
      };
    }),
    q: () => quit("q"),
    "ctrl+c": () => quit("ctrl+c"),
  });
  let unsubscribe = (): void => undefined;
  const stop = (): void => {
    unsubscribe();
    void app.stop().catch(() => undefined);
  };
  try {
    const running = app.run();
    await app.ready();
    if (!controller.signal.aborted) {
      unsubscribe = controller.subscribe((snapshot) => {
        app.update((state) => state.frozen ? state : { ...state, snapshot });
      });
      controller.signal.addEventListener("abort", stop, { once: true });
    }
    if (controller.signal.aborted) {
      await app.stop();
    } else {
      app.update((state) => ({ ...state, snapshot: controller.getSnapshot() }));
      controller.requestHistory(GRAPH_WINDOWS[0]);
    }
    await running;
  } finally {
    controller.signal.removeEventListener("abort", stop);
    unsubscribe();
    app.dispose();
  }
}

