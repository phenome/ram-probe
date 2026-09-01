import { expect, test } from "bun:test";
import { createTestRenderer, type VNode } from "@rezi-ui/core";
import { rankProcesses, type NvidiaAdapterSample, type ProcessSample, type RankedProcess, type Sample } from "./model.ts";
import {
  GRAPH_WINDOWS,
  adapterTotal,
  buildPlotBuckets,
  historyCoverage,
  lineChart,
  openProcessKill,
  moveProcessCursor,
  renderOverview,
  processKillTarget,
  renderDashboard,
  overview,
  worstAdapterPercent,
  type DashboardState,
} from "./ui.ts";

const ORIGIN = Date.parse("2026-07-31T12:00:00Z");

function point(offsetMs: number, value: number | null, intervalMs = 2_000): Sample {
  return {
    timestampUtc: new Date(ORIGIN + offsetMs).toISOString(),
    monotonicMs: offsetMs,
    intervalMs,
    system: { usedPhysicalPercent: value },
    nvidia: [],
  } as unknown as Sample;
}

function adapter(uuid: string, usedVramBytes: number | null, totalVramBytes: number | null): NvidiaAdapterSample {
  return {
    uuid,
    name: null,
    totalVramBytes,
    usedVramBytes,
    freeVramBytes: null,
    utilizationPercent: null,
    temperatureCelsius: null,
    powerWatts: null,
    graphicsClockMhz: null,
    memoryClockMhz: null,
    pState: null,
    pciBusId: null,
    driverVersion: null,
  };
}

test("graph windows include five hours", () => {
  expect(GRAPH_WINDOWS).toEqual([300_000, 1_800_000, 7_200_000, 18_000_000]);
});

test("plot buckets preserve extrema without bridging gaps", () => {
  const values = (sample: Sample) => sample.system.usedPhysicalPercent;
  const dense = buildPlotBuckets([point(0, 1), point(1_000, 9)], values, ORIGIN, 100_000, 2);
  expect(dense[0]).toEqual([{ min: 1, max: 9, last: 9, segment: 0 }]);

  const gapped = buildPlotBuckets([point(0, 1), point(10_000, 9)], values, ORIGIN, 100_000, 2);
  expect(gapped[0]).toEqual([
    { min: 1, max: 1, last: 1, segment: 0 },
    { min: 9, max: 9, last: 9, segment: 1 },
  ]);

  const unavailable = buildPlotBuckets([point(0, 1), point(2_000, null), point(4_000, 3)], values, ORIGIN, 100_000, 2);
  expect(unavailable[0]?.map((bucket) => bucket.segment)).toEqual([0, 1]);
});

test("history coverage counts internal and trailing missing time", () => {
  const coverage = historyCoverage([point(0, 1), point(2_000, 1), point(10_000, 1)], ORIGIN + 20_000);
  expect(coverage).toEqual({ spanMs: 10_000, gapsMs: 14_000 });
});

test("multi-adapter summaries reject partial telemetry", () => {
  const sample = point(0, 1);
  sample.nvidia = [
    adapter("a", 8, 10),
    adapter("b", 1, 10),
  ];
  expect(adapterTotal(sample, "usedVramBytes")).toBe(9);
  expect(worstAdapterPercent(sample)).toBe(80);

  sample.nvidia = [
    adapter("a", 8, 10),
    adapter("b", null, 10),
  ];
  expect(adapterTotal(sample, "usedVramBytes")).toBeNull();
  expect(worstAdapterPercent(sample)).toBeNull();
});

function state(): DashboardState {
  return {
    snapshot: {
      sessionId: "test-session",
      latest: null,
      history: [],
      historyStatus: { requestedWindowMs: 300_000, loadedWindowMs: 300_000, loading: false, error: null },
      rankings: null,
      warnings: { active: {}, counters: {} },
      events: [],
      checkpointTimestampUtc: null,
    },
    view: 1,
    graphWindowMs: 300_000,
    ranking: "privateCommit",
    frozen: true,
    chartEndMs: ORIGIN,
    eventScrollTop: 0,
    graphicsResetOpen: false,
    selectedProcessIdentity: null,
    killTarget: null,
    killHelpOpen: false,
    stoppingProcessIdentity: null,
  };
}

function descendants(node: VNode): readonly VNode[] {
  return [node, ...("children" in node ? node.children.flatMap(descendants) : [])];
}

test("compact charts retain titles and local-time endpoints", () => {
  const chart = lineChart(
    [{ label: "RAM", color: "#ffffff", value: (sample) => sample.system.usedPhysicalPercent, formatValue: String }],
    [point(0, 50)],
    300_000,
    ORIGIN,
    100,
    true,
    "Pressure %",
  );
  const output = createTestRenderer({ viewport: { cols: 40, rows: 3 } }).render(chart).toText();
  expect(output).toContain("Pressure %");
  expect(output).toContain(new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ORIGIN)));
});

test("adaptive charts keep headroom without wasting the plot", () => {
  const chart = lineChart(
    [{ label: "paged", color: "#ffffff", value: (sample) => sample.system.usedPhysicalPercent, formatValue: String }],
    [point(0, 1.67)],
    300_000,
    ORIGIN,
    2,
  );
  const output = createTestRenderer({ viewport: { cols: 40, rows: 12 } }).render(chart).toText();
  expect(output).toContain("3.0");
  expect(output).toContain("1.67");
});

test("overview renders charts responsively and keeps offenders compact", () => {
  const compact = createTestRenderer({ viewport: { cols: 80, rows: 24 } }).render(renderOverview(state(), { width: 80, height: 24 })).toText();
  for (const title of ["Pressure %", "Paging", "Kernel pools GB", "GPU memory GB", "WDDM raw GB"]) {
    expect(compact).toContain(title);
  }
  expect(compact).not.toContain("Top private commit");
  expect(compact).toContain("Span 0s / 5m");

  const full = createTestRenderer({ viewport: { cols: 156, rows: 40 } }).render(renderOverview(state(), { width: 156, height: 40 })).toText();
  for (const title of ["Pressure %", "Paging", "Kernel pools GB", "GPU memory GB", "WDDM raw GB"]) {
    expect(full).toContain(title);
  }
  expect(full).toContain("Top private commit: Collecting process inventory");
  expect(full).toContain("Top GPU resident: Collecting process inventory");
  const wide = createTestRenderer({ viewport: { cols: 200, rows: 32 } }).render(renderOverview(state(), { width: 200, height: 32 })).toText();
  expect(wide).toContain("Top private commit");
  expect(wide).toContain("Top GPU resident");
  expect(wide).toContain("Collecting process inventory");

});

test("warning row includes history coverage", () => {
  const warned = state();
  warned.snapshot.warnings.active["wddm-raw"] = {
    code: "wddm-raw",
    severity: "critical",
    message: "Raw WDDM accounting pressure",
    openedAtUtc: new Date(ORIGIN).toISOString(),
    updatedAtUtc: new Date(ORIGIN).toISOString(),
    value: 120 * 1024 ** 3,
  };
  const output = createTestRenderer({ viewport: { cols: 156, rows: 40 } })
    .render(renderOverview(warned, { width: 156, height: 40 }))
    .toText();
  expect(output.split("\n").find((line) => line.includes("Warnings"))).toContain("Span");
});

test("process view exposes keyboard navigation and confirmed kill context", () => {
  const current = state();
  current.view = 2;
  const renderer = createTestRenderer({ viewport: { cols: 180, rows: 30 } });
  const processView = renderer
    .render(renderDashboard(current, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined))
    .toText();
  expect(processView).toContain("Tab Process");
  expect(processView).toContain("k Stop");
  expect(processView).not.toContain("k/Enter");
  expect(processView).not.toContain("| view 2 |");
  expect(processView.match(/1 Overview/g)).toHaveLength(1);
  const header = descendants(renderDashboard(current, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined));
  const activeTab = header.find((node) => node.kind === "text" && node.text === "2 Processes");
  const inactiveTab = header.find((node) => node.kind === "text" && node.text === "1 Overview");
  if (activeTab?.kind === "text") expect(activeTab.props.style).toEqual({ fg: 0xffffff, bold: true });
  if (inactiveTab?.kind === "text") expect(inactiveTab.props.style).toEqual({ dim: true });
  current.killTarget = { identity: "4242:2026-08-05T12:00:00.0000000Z", pid: 4242, name: "chrome" };
  const output = renderer
    .render(renderDashboard(current, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined))
    .toText();
  expect(output).toContain("Kill process");
  expect(output).toContain("chrome (PID 4242) will be force-stopped.");
  expect(output).toContain("identity will be verified again");
  expect(output).toContain("OK");
  expect(output).toContain("Cancel");
});

test("process kill target follows the active verifiable non-self row", () => {
  const target: ProcessSample = {
    identity: "4242:2026-08-05T12:00:00.0000000Z",
    pid: 4242,
    parentPid: null,
    creationUtc: "2026-08-05T12:00:00.0000000Z",
    name: "chrome",
    executablePath: null,
    commandLine: null,
    privateBytes: 1024,
    privateWorkingSetBytes: 1024,
    workingSetBytes: 1024,
    cpuCorePercent: 0,
    cpuHostPercent: 0,
    ioBytesPerSecond: 0,
    threadCount: 1,
    handleCount: 1,
    wddmRawBytes: 0,
    gpuCommittedBytes: 0,
    gpuResidentBytes: 0,
    self: false,
  };
  const current = state();
  current.view = 2;
  current.selectedProcessIdentity = target.identity;
  current.snapshot.rankings = rankProcesses([target], []);
  current.view = 1;
  expect(processKillTarget(current)).toBeNull();
  current.view = 2;
  expect(processKillTarget(current)?.identity).toBe(target.identity);
  expect(openProcessKill(current).killTarget?.identity).toBe(target.identity);

  current.selectedProcessIdentity = null;
  expect(processKillTarget(current)?.identity).toBe(target.identity);

  const selections: string[] = [];
  const dashboard = renderDashboard(
    current,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    (process) => selections.push(process),
  );
  const tables = descendants(dashboard).filter((node) => node.kind === "table");
  expect(tables.map((node) => node.kind === "table" ? node.props.id : "")).toEqual(["process-rows"]);
  const processes = tables[0];
  if (processes?.kind === "table") {
    expect(processes.props.flex).toBe(1);
    processes.props.onRowPress?.(processes.props.data[0], 0);
  }
  expect(selections).toEqual([target.identity]);

  const other = { ...target, identity: "4243:2026-08-05T12:00:00.0000000Z", pid: 4243, privateBytes: 2048 };
  current.snapshot.rankings = rankProcesses([other, target], []);
  current.selectedProcessIdentity = other.identity;
  expect(moveProcessCursor(current, 1).selectedProcessIdentity).toBe(target.identity);
  expect(moveProcessCursor(current, -1).selectedProcessIdentity).toBe(other.identity);

  const many = Array.from({ length: 8 }, (_, index): ProcessSample => ({
    ...target,
    identity: `${5000 + index}:2026-08-05T12:00:00.0000000Z`,
    pid: 5000 + index,
    privateBytes: 10_000 - index,
  }));
  current.snapshot.rankings = rankProcesses(many, []);
  current.selectedProcessIdentity = many[7]!.identity;
  const fullHeightDashboard = renderDashboard(current, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined);
  const fullHeightTable = descendants(fullHeightDashboard).find((node) => node.kind === "table");
  if (fullHeightTable?.kind === "table") {
    expect(fullHeightTable.props.data).toHaveLength(8);
    expect(fullHeightTable.props.selection).toEqual([many[7]!.identity]);
  }
  current.snapshot.rankings = rankProcesses([other, target], []);
  current.selectedProcessIdentity = target.identity;

  current.stoppingProcessIdentity = target.identity;
  const stoppingDashboard = renderDashboard(current, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined);
  const stopping = createTestRenderer({ viewport: { cols: 180, rows: 30 } }).render(stoppingDashboard).toText();
  expect(stopping).toContain("(stopping…)");
  const stoppingTable = descendants(stoppingDashboard).find((node) => node.kind === "table" && node.props.id === "process-rows");
  if (stoppingTable?.kind === "table") {
    const row = stoppingTable.props.data.find((item) => (item as RankedProcess).identity === target.identity);
    const cell = (row ? stoppingTable.props.columns[0]?.render?.(target.name, row, 0) : undefined) as VNode | undefined;
    const marker = cell && descendants(cell).find((node) => node.kind === "text" && node.text === "(stopping…)");
    if (marker?.kind === "text") expect(marker.props.style).toEqual({ dim: true });
  }

  current.snapshot.rankings = rankProcesses([{ ...target, self: true }], []);
  expect(processKillTarget(current)).toBeNull();
  current.snapshot.rankings = rankProcesses([{ ...target, creationUtc: null }], []);
  expect(processKillTarget(current)).toBeNull();

  const missing = state();
  missing.view = 2;
  expect(openProcessKill(missing).killHelpOpen).toBe(true);
  missing.killHelpOpen = true;
  const help = createTestRenderer({ viewport: { cols: 100, rows: 24 } })
    .render(renderDashboard(missing, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined))
    .toText();
  expect(help).toContain("Process cannot be stopped");
  expect(help).toContain("stable process identity");
});

test("events are not a trapped Tab stop", () => {
  const current = state();
  current.view = 3;
  current.snapshot.events = [
    { id: "old", timestampUtc: "2026-08-05T12:00:00Z", level: "info", source: "test", message: "old" },
    { id: "new", timestampUtc: "2026-08-05T12:01:00Z", level: "info", source: "test", message: "new" },
  ];
  const scrolls: number[] = [];
  const dashboard = renderDashboard(
    current,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    (scrollTop) => scrolls.push(scrollTop),
  );
  const logs = descendants(dashboard).find((node) => node.kind === "logsConsole");
  expect(logs?.kind).toBe("logsConsole");
  if (logs?.kind === "logsConsole") {
    expect(logs.props.focusable).toBe(false);
    expect(logs.props.focusConfig).toEqual({ indicator: "none", contentStyle: {} });
    expect(logs.props.autoScroll).toBe(false);
    expect(logs.props.entries.map((entry) => entry.id)).toEqual(["new", "old"]);
    logs.props.onScroll(4);
  }
  expect(scrolls).toEqual([4]);

  const output = createTestRenderer({ viewport: { cols: 180, rows: 30 } }).render(dashboard).toText();
  expect(output.match(/1 Overview/g)).toHaveLength(1);
  expect(output).not.toContain("Tab");
});
