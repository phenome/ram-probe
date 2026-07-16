import { defineWidget, rgb, ui, type LogEntry, type Rgb24, type TableColumn, type VNode } from "@rezi-ui/core";
import { createNodeApp } from "@rezi-ui/node";
import type {
  ProcessGroup,
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
  rankings: ProcessRankings | null;
  warnings: WarningState;
  events: readonly DashboardEvent[];
  checkpointTimestampUtc: string | null;
}

export interface DashboardController {
  signal: AbortSignal;
  getSnapshot(): DashboardSnapshot;
  subscribe(listener: (snapshot: DashboardSnapshot) => void): () => void;
  shutdown(reason: string): Promise<void>;
}

interface DashboardState {
  snapshot: DashboardSnapshot;
  view: 1 | 2 | 3;
  graphWindowMs: number;
  ranking: RankingDimension;
  frozen: boolean;
  eventScrollTop: number;
}

const GRAPH_WINDOWS = [300_000, 1_800_000, 7_200_000] as const;
const RANKINGS: readonly RankingDimension[] = ["privateCommit", "privateWorkingSet", "workingSet", "cpu", "io", "wddm", "growth"];

interface AreaSeries {
  data: readonly number[];
  color: string;
  fillColor: string;
  label: string;
  formatValue(value: number): string;
}

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

function orangeCard(title: string, children: readonly VNode[], expand = false): VNode {
  return ui.box({
    border: "rounded",
    borderStyle: { fg: rgb(245, 158, 11) },
    p: 1,
    ...(expand ? { height: "full" as const } : {}),
  }, [
    ui.column({ gap: 1, ...(expand ? { height: "full" as const } : {}) }, [
      ui.text(title, { variant: "heading" }),
      ...(expand ? [ui.box({ border: "none", flex: 1, minHeight: 7, overflow: "hidden" }, children)] : children),
    ]),
  ]);
}

function areaChart(series: readonly AreaSeries[]): VNode {
  const visible = series.filter((entry) => entry.data.length);
  let maximum = 1;
  for (const entry of visible) {
    for (const value of entry.data) maximum = Math.max(maximum, value);
  }
  const labeled = [...visible].sort((left, right) => (right.data.at(-1) ?? 0) - (left.data.at(-1) ?? 0));
  return ui.canvas({
      width: "full",
      height: "full",
      blitter: "braille",
      draw: (canvas) => {
        const legendHeight = 4;
        const plotHeight = Math.max(1, canvas.height - legendHeight);
        const labelWidth = 16;
        const plotWidth = Math.max(2, canvas.width - labelWidth);
        for (let seriesIndex = 0; seriesIndex < visible.length; seriesIndex++) {
          const entry = visible[seriesIndex]!;
          for (let x = 0; x < plotWidth; x++) {
            const position = entry.data.length === 1 ? 0 : x / Math.max(1, plotWidth - 1) * (entry.data.length - 1);
            const left = Math.floor(position);
            const right = Math.min(entry.data.length - 1, Math.ceil(position));
            const value = (entry.data[left] ?? 0) + ((entry.data[right] ?? 0) - (entry.data[left] ?? 0)) * (position - left);
            const y = Math.round((plotHeight - 1) * (1 - Math.max(0, value) / maximum));
            for (let fillY = y; fillY < plotHeight; fillY++) {
              if ((x + fillY) % visible.length === seriesIndex) canvas.setPixel(x, fillY, entry.fillColor);
            }
          }
        }
        for (const entry of visible) {
          for (let index = 1; index < entry.data.length; index++) {
            const previous = entry.data[index - 1] ?? 0;
            const current = entry.data[index] ?? 0;
            const x0 = (index - 1) / Math.max(1, entry.data.length - 1) * (plotWidth - 1);
            const x1 = index / Math.max(1, entry.data.length - 1) * (plotWidth - 1);
            const y0 = (plotHeight - 1) * (1 - Math.max(0, previous) / maximum);
            const y1 = (plotHeight - 1) * (1 - Math.max(0, current) / maximum);
            canvas.line(x0, y0, x1, y1, entry.color);
          }
        }
        const rowCount = Math.max(1, Math.floor(plotHeight / 4));
        const labels = labeled.map((entry) => {
          const value = entry.data.at(-1) ?? 0;
          const endpointY = (plotHeight - 1) * (1 - Math.max(0, value) / maximum);
          return { entry, value, endpointY };
        });
        const rows: number[] = [];
        for (let start = 0; start < labels.length;) {
          let end = start + 1;
          while (end < labels.length && labels[end]!.endpointY - labels[end - 1]!.endpointY < 4) end++;
          const count = end - start;
          const midpoint = labels.slice(start, end).reduce((sum, label) => sum + label.endpointY, 0) / count;
          const idealFirst = Math.round((midpoint - 2) / 4 - (count - 1) / 2);
          const first = Math.min(rowCount - (labels.length - start), Math.max((rows.at(-1) ?? -1) + 1, idealFirst));
          for (let index = 0; index < count; index++) rows.push(first + index);
          start = end;
        }
        for (let index = 0; index < labels.length; index++) {
          const { entry, value } = labels[index]!;
          const labelY = rows[index]! * 4;
          canvas.text(plotWidth + 2, labelY, entry.formatValue(value), entry.color);
        }
        let legendX = 0;
        for (const entry of series) {
          canvas.text(legendX, plotHeight, entry.label, entry.color);
          legendX += (entry.label.length + 2) * 2;
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

function ratio(value: number | null, total: number | null): number {
  return value === null || !total ? 0 : Math.max(0, Math.min(1, value / total));
}

function chartHistory(state: DashboardState): readonly Sample[] {
  const latest = state.snapshot.latest;
  if (!latest) return [];
  return state.snapshot.history.filter((sample) => sample.monotonicMs >= latest.monotonicMs - state.graphWindowMs);
}

function overview(state: DashboardState): VNode {
  const sample = state.snapshot.latest;
  if (!sample) return ui.empty("Waiting for first sample");
  const system = sample.system;
  const history = chartHistory(state);
  const ram = history.map((item) => item.system.usedPhysicalPercent ?? 0);
  const commit = history.map((item) => ratio(item.system.committedBytes, item.system.commitLimitBytes) * 100);
  const available = history.map((item) => (item.system.availablePhysicalBytes ?? 0) / 1024 ** 3);
  const paged = history.map((item) => (item.system.pagedPoolAllocatedBytes ?? 0) / 1024 ** 3);
  const nonpaged = history.map((item) => (item.system.nonpagedPoolBytes ?? 0) / 1024 ** 3);
  const wddm = history.map((item) => ((item.system.wddmDedicatedBytes ?? 0) + (item.system.wddmSharedBytes ?? 0)) / 1024 ** 3);
  const dwm = history.map((item) => (item.system.dwmWddmBytes ?? 0) / 1024 ** 3);
  const vram = history.map((item) => (item.nvidia.reduce((sum, adapter) => sum + (adapter.usedVramBytes ?? 0), 0)) / 1024 ** 3);
  const nvidiaUsed = sample.nvidia.reduce((sum, adapter) => sum + (adapter.usedVramBytes ?? 0), 0);
  const nvidiaTotal = sample.nvidia.reduce((sum, adapter) => sum + (adapter.totalVramBytes ?? 0), 0);
  const warningCodes = Object.keys(state.snapshot.warnings.active);
  const offender = state.snapshot.rankings?.topPrivateCommit.slice(0, 5) ?? [];

  return ui.column({ gap: 1, height: "full" }, [
    ...(warningCodes.length ? [ui.callout(warningCodes.join(", "), { variant: "error", title: "===WARNING===" })] : []),
    ui.row({ gap: 1 }, [
      ui.gauge((system.usedPhysicalPercent ?? 0) / 100, { label: `RAM ${percent(system.usedPhysicalPercent)}`, thresholds: [{ value: 0.9, variant: "warning" }, { value: 0.95, variant: "error" }] }),
      ui.gauge(ratio(system.committedBytes, system.commitLimitBytes), { label: `Commit ${percent(ratio(system.committedBytes, system.commitLimitBytes) * 100)}` }),
      ui.gauge(ratio(system.pagefileCurrentBytes, system.pagefileAllocatedBytes), { label: `Pagefile ${bytes(system.pagefileCurrentBytes)}` }),
      ui.gauge(ratio(nvidiaUsed, nvidiaTotal), { label: `VRAM ${bytes(nvidiaUsed)}` }),
    ]),
    ui.row({ gap: 1, flex: 1, minHeight: 10 }, [
      ui.box({ border: "none", flex: 1, flexBasis: 0, height: "full" }, [orangeCard("RAM / commit / available", [areaChart([
        { label: "RAM %", color: "#fbbf24", fillColor: "#4a3610", data: ram, formatValue: chartPercent },
        { label: "commit %", color: "#f87171", fillColor: "#4a1f24", data: commit, formatValue: chartPercent },
        { label: "available GB", color: "#4ade80", fillColor: "#153d2b", data: available, formatValue: chartGigabytes },
      ])], true)]),
      ui.box({ border: "none", flex: 1, flexBasis: 0, height: "full" }, [orangeCard("Kernel pools (GB)", [areaChart([
        { label: "paged", color: "#fb923c", fillColor: "#4a2915", data: paged, formatValue: chartGigabytes },
        { label: "nonpaged", color: "#f87171", fillColor: "#4a1f24", data: nonpaged, formatValue: chartGigabytes },
      ])], true)]),
      ui.box({ border: "none", flex: 1, flexBasis: 0, height: "full" }, [orangeCard("GPU allocations (GB)", [areaChart([
        { label: "WDDM", color: "#22d3ee", fillColor: "#123b43", data: wddm, formatValue: chartGigabytes },
        { label: "DWM", color: "#fb923c", fillColor: "#4a2915", data: dwm, formatValue: chartGigabytes },
        { label: "VRAM", color: "#4ade80", fillColor: "#153d2b", data: vram, formatValue: chartGigabytes },
      ])], true)]),
    ]),
    orangeCard("Top private commit", offender.length
      ? offender.map((process) => ui.text(`${process.self ? "[self] " : ""}${process.name} (${process.pid})  ${bytes(process.privateBytes)}`))
      : [ui.text("No process inventory yet")]),
  ]);
}

function rightCell(content: string, width: number): VNode {
  return ui.text(content.padStart(width));
}

const GROUP_COLUMNS: readonly TableColumn<ProcessGroup>[] = [
  { key: "name", header: "Executable", flex: 1 },
  { key: "count", header: "Count", width: 7, align: "right" },
  { key: "privateBytes", header: "Private", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.privateBytes), 11) },
  { key: "privateWorkingSetBytes", header: "Private WS", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.privateWorkingSetBytes), 11) },
  { key: "workingSetBytes", header: "WS", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.workingSetBytes), 11) },
  { key: "cpuHostPercent", header: "CPU", width: 8, align: "right", render: (_, row) => rightCell(percent(row.cpuHostPercent), 8) },
  { key: "ioBytesPerSecond", header: "I/O", width: 10, align: "right", render: (_, row) => rightCell(`${bytes(row.ioBytesPerSecond)}/s`, 10) },
  { key: "wddmBytes", header: "WDDM", width: 10, align: "right", render: (_, row) => rightCell(bytes(row.wddmBytes), 10) },
  { key: "growth60SecondsBytes", header: "Growth", width: 10, align: "right", render: (_, row) => rightCell(bytes(row.growth60SecondsBytes), 10) },
];

const PROCESS_COLUMNS: readonly TableColumn<RankedProcess>[] = [
  { key: "name", header: "Process", flex: 1, render: (_, row) => ui.text(`${row.self ? "[self] " : ""}${row.name}`) },
  { key: "pid", header: "PID", width: 8, align: "right" },
  { key: "privateBytes", header: "Private", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.privateBytes), 11) },
  { key: "privateWorkingSetBytes", header: "Private WS", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.privateWorkingSetBytes), 11) },
  { key: "workingSetBytes", header: "WS", width: 11, align: "right", render: (_, row) => rightCell(bytes(row.workingSetBytes), 11) },
  { key: "cpuHostPercent", header: "CPU", width: 8, align: "right", render: (_, row) => rightCell(percent(row.cpuHostPercent), 8) },
  { key: "ioBytesPerSecond", header: "I/O", width: 10, align: "right", render: (_, row) => rightCell(`${bytes(row.ioBytesPerSecond)}/s`, 10) },
  { key: "wddm", header: "WDDM", width: 10, align: "right", render: (_, row) => rightCell(bytes((row.wddmDedicatedBytes ?? 0) + (row.wddmSharedBytes ?? 0)), 10) },
  { key: "growth60SecondsBytes", header: "Growth", width: 10, align: "right", render: (_, row) => rightCell(bytes(row.growth60SecondsBytes), 10) },
];

function selectedRanking(rankings: ProcessRankings, dimension: RankingDimension): readonly RankedProcess[] {
  switch (dimension) {
    case "privateCommit": return rankings.topPrivateCommit;
    case "privateWorkingSet": return rankings.topPrivateWorkingSet;
    case "workingSet": return rankings.topWorkingSet;
    case "cpu": return rankings.topCpu;
    case "io": return rankings.topIo;
    case "wddm": return rankings.topWddm;
    case "growth": return rankings.topGrowth;
  }
}

function groupedRanking(groups: readonly ProcessGroup[], dimension: RankingDimension): readonly ProcessGroup[] {
  const value = (group: ProcessGroup): number => {
    switch (dimension) {
      case "privateCommit": return group.privateBytes;
      case "privateWorkingSet": return group.privateWorkingSetBytes;
      case "workingSet": return group.workingSetBytes;
      case "cpu": return group.cpuHostPercent;
      case "io": return group.ioBytesPerSecond;
      case "wddm": return group.wddmBytes;
      case "growth": return group.growth60SecondsBytes;
    }
  };
  return [...groups].sort((left, right) => value(right) - value(left) || left.name.localeCompare(right.name));
}

const Processes = defineWidget<{
  rankings: ProcessRankings | null;
  ranking: RankingDimension;
  key?: string;
}>((props, ctx) => {
  const [selection, setSelection] = ctx.useState<{ executable: string | null; process: string | null }>({
    executable: null,
    process: null,
  });
  if (!props.rankings) return ui.empty("Waiting for process inventory");
  const groups = groupedRanking(props.rankings.byExecutable, props.ranking);
  const rows = selectedRanking(props.rankings, props.ranking);
  return ui.column({ gap: 1, height: "full" }, [
    ui.text(`Ranking: ${props.ranking}`),
    ui.table({
      id: ctx.id("groups"),
      key: `groups-${props.ranking}`,
      columns: GROUP_COLUMNS,
      data: groups,
      getRowKey: (row) => row.name,
      selection: selection.executable ? [selection.executable] : [],
      selectionMode: "single",
      onSelectionChange: (keys) => {
        const executable = keys[0] ?? null;
        const process = executable ? rows.find((row) => row.name.toLowerCase() === executable) : undefined;
        setSelection({ executable, process: process?.identity ?? null });
      },
      border: "single",
      flex: 1,
      minHeight: 5,
    }),
    ui.table({
      id: ctx.id("rows"),
      key: `rows-${props.ranking}`,
      columns: PROCESS_COLUMNS,
      data: rows,
      getRowKey: (row) => row.identity,
      selection: selection.process ? [selection.process] : [],
      selectionMode: "single",
      onSelectionChange: (keys) => {
        const process = keys[0] ?? null;
        const row = process ? rows.find((candidate) => candidate.identity === process) : undefined;
        setSelection({ executable: row?.name.toLowerCase() ?? null, process });
      },
      border: "single",
      flex: 1,
      minHeight: 5,
    }),
  ]);
}, { name: "Processes" });

function events(state: DashboardState): VNode {
  const entries: LogEntry[] = state.snapshot.events.map((event) => ({
    id: event.id,
    timestamp: Date.parse(event.timestampUtc),
    level: event.level,
    source: event.source,
    message: event.message,
  }));
  return ui.logsConsole({
    id: "events",
    entries,
    autoScroll: true,
    scrollTop: state.eventScrollTop,
    onScroll: () => undefined,
    showTimestamps: true,
    showSource: true,
    height: "full",
  });
}

function footerLegend(state: DashboardState): string {
  const navigation = "1 Overview  2 Processes  3 Events";
  const freeze = `Space ${state.frozen ? "Resume" : "Freeze"}  q Quit`;
  if (state.view === 1) {
    const minutes = state.graphWindowMs / 60_000;
    const window = minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
    return `${navigation}  w Window (${window})  ${freeze}`;
  }
  if (state.view === 2) return `${navigation}  r Ranking (${state.ranking})  ${freeze}`;
  return `${navigation}  ${freeze}`;
}

function view(state: DashboardState): VNode {
  const latest = state.snapshot.latest;
  const windowMinutes = state.graphWindowMs / 60_000;
  const degraded = latest
    ? Object.entries(latest.sources).filter(([, health]) => health.state !== "ok").map(([name]) => name)
    : [];
  const body = state.view === 1 ? overview(state) : state.view === 2
    ? Processes({ key: "processes", rankings: state.snapshot.rankings, ranking: state.ranking })
    : events(state);
  return ui.column({ p: 1, gap: 1, height: "full" }, [
    ui.header({
      title: "ram-probe",
      subtitle: `${latest?.timestampUtc ?? "waiting"} | view ${state.view} | ${windowMinutes >= 60 ? `${windowMinutes / 60}h` : `${windowMinutes}m`} | ${state.frozen ? "FROZEN" : "live"}${degraded.length ? ` | degraded: ${degraded.join(",")}` : ""}`,
    }),
    ui.box({ border: "none", flex: 1, minHeight: 1, overflow: "hidden" }, [body]),
    ui.statusBar({
      left: [ui.text(footerLegend(state))],
      right: [ui.text(`session ${state.snapshot.sessionId.slice(0, 8)}`)],
    }),
  ]);
}

export async function createDashboard(controller: DashboardController): Promise<void> {
  const initialState: DashboardState = {
    snapshot: controller.getSnapshot(),
    view: 1,
    graphWindowMs: GRAPH_WINDOWS[0],
    ranking: RANKINGS[0]!,
    frozen: false,
    eventScrollTop: 0,
  };
  const app = createNodeApp({ initialState, config: { fpsCap: 20, rootPadding: 0 } });
  app.view(view);
  let frozen = false;
  const unsubscribe = controller.subscribe((snapshot) => {
    if (!frozen) app.update((state) => ({ ...state, snapshot }));
  });
  const quit = (reason: string): void => {
    void controller.shutdown(reason);
  };
  app.keys({
    "1": ({ update }) => update((state) => ({ ...state, view: 1 })),
    "2": ({ update }) => update((state) => ({ ...state, view: 2 })),
    "3": ({ update }) => update((state) => ({ ...state, view: 3 })),
    w: {
      when: ({ state }) => state.view === 1,
      handler: ({ update, state }) => {
        const index = GRAPH_WINDOWS.indexOf(state.graphWindowMs as typeof GRAPH_WINDOWS[number]);
        update({ ...state, graphWindowMs: GRAPH_WINDOWS[(index + 1) % GRAPH_WINDOWS.length]! });
      },
    },
    r: {
      when: ({ state }) => state.view === 2,
      handler: ({ update, state }) => {
        const index = RANKINGS.indexOf(state.ranking);
        update({ ...state, ranking: RANKINGS[(index + 1) % RANKINGS.length]! });
      },
    },
    space: ({ update, state }) => {
      frozen = !state.frozen;
      update({ ...state, frozen, snapshot: frozen ? state.snapshot : controller.getSnapshot() });
    },
    q: () => quit("q"),
    "ctrl+c": () => quit("ctrl+c"),
  });
  const stop = (): void => void app.stop();
  controller.signal.addEventListener("abort", stop, { once: true });
  try {
    await app.run();
  } finally {
    controller.signal.removeEventListener("abort", stop);
    unsubscribe();
    app.dispose();
  }
}
